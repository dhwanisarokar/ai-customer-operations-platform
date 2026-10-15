import { randomUUID } from "node:crypto";
import { transaction } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import type { Prisma } from "@/generated/prisma/client";
import { sendMessageSchema } from "@/features/conversations/schemas";
import { createLogger } from "@/lib/logger";
import { getServerEnv } from "@/lib/env";
import type { OrganizationContext } from "@/server/auth/context";
import type { EmailSendJob } from "@/server/automation/queue/types";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { RateLimitError } from "@/server/rate-limit";
import { buildRealtimeEvent } from "@/server/realtime/events";
import { inboxChannel } from "@/server/realtime/channels";
import { publishRealtime } from "@/server/realtime/publisher";
import { metrics } from "@/server/observability/metrics";
import { emailInboundRepository } from "@/server/repositories/email-inbound";
import {
  conversationMessagesRepository,
  type MessageRecord,
} from "@/server/repositories/conversation-messages";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import {
  outboundEmailRepository,
  type OutboundEmailRow,
} from "@/server/repositories/outbound-email";
import {
  announcePersistedMessage,
  persistMessageInTransaction,
  type PersistedMessage,
} from "@/server/services/conversation-messages";
import { requireConversationState } from "@/server/services/conversations";
import { toDeliveryDto, type MessageDeliveryDto } from "./delivery-state";
import { normalizeEmailAddress } from "./address";
import { rawSubject, validRfcId } from "./inbound-content";
import { getEmailPlatformDomain, getSendingProvider } from "./index";
import { enforceOutboundLimits } from "./outbound-limits";
import {
  LEASE_MARGIN_MS,
  OUTBOUND_POLICY,
  backoffMs,
  decideAfterAttempt,
  decideAmbiguous,
  leaseFor,
  sanitizeErrorCode,
  settleWindowMs,
  type FailureReason,
  type FinalDecision,
} from "./outbound-state";
import type { EmailProvider, OutboundEmail, SendLookup, SendResult } from "./provider";

const log = createLogger("email-outbound");

/**
 * Outbound email delivery (Phase 9.3A). Read `outbound-state.ts` first: it states the execution model, the
 * state machine and the exact limits of the duplicate-send guarantees.
 *
 * Division of labour:
 *  - `createOutboundReply` / `recordOutboundEmail`: durably record a send, atomically with the message;
 *  - the queue job (`processEmailSendJob`): a wake-up that claims one send and attempts delivery;
 *  - `reconcileOutboundEmail` (the worker's maintenance pass): re-creates lost wake-ups and resolves attempts whose
 *    worker died. The table is the truth; the queue is only a hint.
 *
 * Privacy: bodies and addresses are never logged and never put on the queue; the message text is read from
 * `messages` at send time; provider errors are reduced to short codes.
 */

/** Clock, randomness and timing are injectable so every path is testable deterministically. */
export type OutboundDeps = {
  now?: () => Date;
  random?: () => number;
  sendTimeoutMs?: number;
  leaseMs?: number;
  maxAttempts?: number;
};

const THREAD_REFERENCES = 20;

// ---- recording a send ---------------------------------------------------------------------------------

/** "Re: <subject>", once. One line, bounded, header-safe. */
function replySubject(subject: string): string {
  const clean = rawSubject(subject);
  return /^re\s*:/i.test(clean) ? clean : `Re: ${clean}`.slice(0, 500);
}

/**
 * The threading headers of a reply, derived ONLY from the Message-IDs already recorded for this conversation (inside
 * this organization), never from the subject. `In-Reply-To` is the customer's latest message when there is one,
 * otherwise the latest known id; `References` is the chain oldest to newest ending with it.
 */
export function buildThreading(
  ids: { rfcMessageId: string | null; direction: "INBOUND" | "OUTBOUND" }[],
): { inReplyTo: string | null; references: string[] } {
  const valid = ids.flatMap((row) => {
    const id = validRfcId(row.rfcMessageId);
    return id ? [{ id, direction: row.direction }] : [];
  });
  if (valid.length === 0) return { inReplyTo: null, references: [] };
  // `ids` is newest first.
  const parent = valid.find((row) => row.direction === "INBOUND") ?? valid[0];
  const chain = [...valid].reverse().map((row) => row.id);
  const unique = [...new Set(chain)].filter((id) => id !== parent.id);
  return {
    inReplyTo: parent.id,
    references: [...unique.slice(-(THREAD_REFERENCES - 1)), parent.id],
  };
}

/**
 * Records the outbound send for a staff message that was JUST stored in `tx`: the send row (PENDING), and the
 * OUTBOUND `email_messages` row that lets the customer's reply thread to our Message-ID. Everything is derived on
 * the server inside the organization: the recipient from the customer record, the sender from the organization's
 * verified settings, the threading from this conversation's recorded ids.
 */
export async function recordOutboundEmail(
  tx: Prisma.TransactionClient,
  params: { organizationId: string; conversationId: string; messageId: string; now?: Date },
): Promise<{ sendId: string }> {
  const { organizationId, conversationId, messageId } = params;
  const now = params.now ?? new Date();

  const conversation = await outboundEmailRepository.conversationForSend(
    organizationId,
    conversationId,
    tx,
  );
  if (!conversation) throw new NotFoundError("Conversation not found");
  if (conversation.channel !== "EMAIL") {
    throw new ConflictError("Only email conversations can be answered by email");
  }
  if (conversation.customer.status === "ARCHIVED") {
    throw new ConflictError("Archived customers cannot be emailed");
  }
  const to = conversation.customer.email
    ? normalizeEmailAddress(conversation.customer.email)
    : null;
  if (!to) throw new ConflictError("This customer has no email address");

  const settings = await emailSettingsRepository.findByOrganization(organizationId, tx);
  const domain = getEmailPlatformDomain();
  if (
    !settings ||
    !settings.enabled ||
    settings.status !== "ACTIVE" ||
    !domain ||
    !usableProvider()
  ) {
    throw new ConflictError("Email is not set up for this organization");
  }

  const sendId = randomUUID();
  const rfcMessageId = validRfcId(`<${sendId}@${domain}>`);
  if (!rfcMessageId) throw new ValidationError("Could not build a Message-ID");
  const threading = buildThreading(
    await outboundEmailRepository.threadIds(organizationId, conversationId, THREAD_REFERENCES, tx),
  );
  const subject = replySubject(conversation.subject);

  await outboundEmailRepository.create(
    {
      id: sendId,
      organizationId,
      conversationId,
      messageId,
      emailSettingsId: settings.id,
      fromAddress: settings.supportAddress,
      fromName: settings.fromName,
      toAddress: to,
      subject,
      rfcMessageId,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      nextAttemptAt: now,
    },
    tx,
  );
  // The thread index: a customer's reply to this email carries our Message-ID in In-Reply-To.
  await emailInboundRepository.createEmailMessage(
    {
      organizationId,
      conversationId,
      messageId,
      direction: "OUTBOUND",
      providerMessageId: null,
      rfcMessageId,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
      fromAddress: settings.supportAddress,
      fromName: settings.fromName,
      toAddresses: [to],
      ccAddresses: [],
      subject,
      spf: "none",
      dkim: "none",
      attachments: [],
      receivedAt: now,
    },
    tx,
  );
  return { sendId };
}

export type OutboundReplyResult = {
  messageId: string;
  sendId: string;
  /** True when this request repeated an earlier one: nothing new was created or queued. */
  duplicate: boolean;
  message: MessageRecord;
  delivery: MessageDeliveryDto;
};

/**
 * A staff reply on an email conversation: the message and its outbound send commit TOGETHER (a message that will be
 * emailed always has its send, and a send never exists without its message). After the commit the message events are
 * published and a wake-up is queued; both are best effort, because the row is durable and the reconciler covers
 * anything lost.
 *
 * Idempotency: `clientMessageId` is a key the BROWSER generates once per logical reply and reuses on every retry. The
 * messages table is unique on (conversation, clientMessageId), so two requests with the same key can never create two
 * messages, and therefore never two sends (one send per message). A repeat returns the original, creates nothing and
 * queues nothing. The same key with different content, from another user, or for a message that is not an email
 * reply is refused rather than answered with someone else's record. Without a key (internal callers only) there is no
 * deduplication: the HTTP route always requires one.
 *
 * Everything that decides WHERE and AS WHOM the email goes is read here from persisted records inside the caller's
 * organization (the conversation's customer, the organization's verified settings); the caller supplies only the text.
 */
export async function createOutboundReply(
  ctx: OrganizationContext,
  conversationId: string,
  input: { body: string; clientMessageId?: string },
  deps: OutboundDeps = {},
): Promise<OutboundReplyResult> {
  ctx.require("send_messages");
  const organizationId = ctx.organization.id;
  const messageInput = sendMessageSchema.parse({ body: input.body, type: "MESSAGE", from: "USER" });
  const clientMessageId = input.clientMessageId;
  // The conversation must exist in THIS organization (a foreign or unknown id is "not found").
  await requireConversationState(ctx, conversationId);

  const repeated = async (): Promise<OutboundReplyResult | null> => {
    if (!clientMessageId) return null;
    const existing = await conversationMessagesRepository.findByClientMessageId(
      organizationId,
      conversationId,
      clientMessageId,
    );
    if (!existing) return null;
    const send = await outboundEmailRepository.findByMessage(organizationId, existing.id);
    if (!send || existing.senderUserId !== ctx.user.id || existing.body !== messageInput.body) {
      throw new ConflictError("This request id was already used for a different message");
    }
    return {
      messageId: existing.id,
      sendId: send.id,
      duplicate: true,
      message: existing,
      delivery: toDeliveryDto(send),
    };
  };

  const earlier = await repeated();
  if (earlier) return earlier;

  const params = {
    organizationId,
    actor: { kind: "user", userId: ctx.user.id } as const,
    conversationId,
    input: messageInput,
    emailReply: true,
    ...(clientMessageId ? { clientMessageId } : {}),
  };

  let stored: { persisted: PersistedMessage; sendId: string };
  try {
    stored = await transaction(async (tx) => {
      // Abuse limits first (they take a per-organization lock and refuse before anything is written): see
      // `outbound-limits.ts`. The recipient is the customer's address, read here exactly as `recordOutboundEmail` will.
      const target = await outboundEmailRepository.conversationForSend(
        organizationId,
        conversationId,
        tx,
      );
      const recipient = target?.customer.email
        ? normalizeEmailAddress(target.customer.email)
        : null;
      if (recipient) {
        await enforceOutboundLimits(tx, {
          organizationId,
          userId: ctx.user.id,
          toAddress: recipient,
        });
      }
      const persisted = await persistMessageInTransaction(tx, params);
      const send = await recordOutboundEmail(tx, {
        organizationId,
        conversationId,
        messageId: persisted.message.id,
        now: deps.now?.(),
      });
      return { persisted, sendId: send.sendId };
    });
  } catch (error) {
    // A concurrent request with the same key won the race (the unique key rejected this one, or it took the last slot of
    // a limit first): answer with that one. A repeat of a request that already exists is never "over the limit".
    if (clientMessageId && (isUniqueViolation(error) || error instanceof RateLimitError)) {
      const winner = await repeated();
      if (winner) return winner;
    }
    throw error;
  }

  await announcePersistedMessage(params, stored.persisted);
  await wakeUp({ id: stored.sendId, organizationId, attempts: 0 });
  const send = await outboundEmailRepository.find(stored.sendId, organizationId);
  return {
    messageId: stored.persisted.message.id,
    sendId: stored.sendId,
    duplicate: false,
    message: stored.persisted.message,
    delivery: toDeliveryDto(send!),
  };
}

/** A hint to staff clients that a delivery changed: they refetch the (authorized) message list. Best effort. */
async function publishDeliveryChanged(row: {
  organizationId: string;
  conversationId: string;
  messageId: string;
}) {
  try {
    await publishRealtime(
      inboxChannel(row.organizationId),
      buildRealtimeEvent("conversation.updated", row.conversationId, row.messageId),
    );
  } catch {
    // A lost hint only means a client refetches a little later.
  }
}

// ---- wake-ups -----------------------------------------------------------------------------------------

/** Queues a wake-up for a send. Never throws: a failure is counted and the reconciler tries again. */
export async function wakeUp(send: {
  id: string;
  organizationId: string;
  attempts: number;
}): Promise<boolean> {
  try {
    // Lazy: the job router imports this module.
    const { getAutomationQueue, ensureInlineWorker } = await import("@/server/automation/queue");
    const { processQueueJob } = await import("@/server/jobs");
    const queue = getAutomationQueue();
    await ensureInlineWorker(processQueueJob);
    await queue.enqueue({
      kind: "email-send",
      executionId: `email-send-${send.id}-${send.attempts}`,
      organizationId: send.organizationId,
      sendId: send.id,
    });
    return true;
  } catch (error) {
    log.warn(
      {
        organizationId: send.organizationId,
        sendId: send.id,
        err: error instanceof Error ? error.name : "unknown",
      },
      "could not queue an email wake-up; the reconciler will",
    );
    metrics.increment("email_outbound_total", { result: "wakeup_failed" });
    return false;
  }
}

// ---- delivering ---------------------------------------------------------------------------------------

/**
 * The provider that may send right now, or null. `getSendingProvider` applies the capability policy (declarations must
 * be consistent and strong enough, and verified in production), so an unsafe provider is never used in a weaker mode.
 * Defense in depth on top of env validation: the fake provider can never deliver in production.
 */
export function usableProvider(): EmailProvider | null {
  const provider = getSendingProvider();
  if (!provider) return null;
  if (provider.name === "fake" && getServerEnv().NODE_ENV === "production") {
    log.error("the fake email provider is configured in production; outbound email is refused");
    return null;
  }
  return provider;
}

/** Resolves after `ms` with `timeout`; used to bound a provider call that may hang. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function lookupByKey(
  provider: EmailProvider,
  sendId: string,
  timeoutMs: number,
): Promise<SendLookup | null> {
  if (!provider.sending.lookupByKey || !provider.findSendByKey) return null;
  try {
    const result = await withTimeout(provider.findSendByKey(sendId), timeoutMs);
    return result === "timeout" ? { status: "unavailable" } : result;
  } catch {
    return { status: "unavailable" };
  }
}

/** Applies a decision with the fenced conditional update. Returns false when this attempt is no longer the current one. */
async function applyDecision(
  row: OutboundEmailRow,
  attempt: number,
  decision: FinalDecision,
  deps: Required<Pick<OutboundDeps, "now">>,
): Promise<boolean> {
  const now = deps.now();
  const { id, organizationId } = row;
  let applied: boolean;
  try {
    switch (decision.to) {
      case "SENT":
        applied = await outboundEmailRepository.markSent(
          id,
          organizationId,
          attempt,
          decision.providerMessageId,
          now,
        );
        if (applied) {
          await outboundEmailRepository
            .setThreadProviderId(organizationId, row.messageId, decision.providerMessageId)
            .catch(() => undefined);
        }
        break;
      case "RETRY_SCHEDULED":
        applied = await outboundEmailRepository.scheduleRetry(
          id,
          organizationId,
          attempt,
          decision.code,
          new Date(now.getTime() + decision.delayMs),
          now,
          undefined,
          !decision.noCall,
        );
        break;
      case "FAILED":
        applied = await outboundEmailRepository.markFailed(
          id,
          organizationId,
          attempt,
          decision.code,
          decision.reason,
          now,
        );
        break;
      case "UNKNOWN":
        applied = await outboundEmailRepository.markUnknown(
          id,
          organizationId,
          attempt,
          decision.code,
          now,
        );
        break;
    }
  } catch (error) {
    // The provider may already have accepted the email, but we could not record it. The row stays PROCESSING;
    // when its lease expires the reconciler resolves it as an unknown outcome (lookup / idempotent retry /
    // UNKNOWN). It is NEVER recorded as sent without proof and never resent blindly.
    log.error(
      {
        organizationId,
        sendId: id,
        to: decision.to,
        err: error instanceof Error ? error.name : "unknown",
      },
      "could not record the outcome of an email attempt; recovery will resolve it",
    );
    metrics.increment("email_outbound_total", { result: "finalize_failed" });
    return false;
  }
  if (!applied) {
    log.warn(
      { organizationId, sendId: id, to: decision.to },
      "stale email attempt: another worker owns this send",
    );
    metrics.increment("email_outbound_total", { result: "stale" });
    return false;
  }
  metrics.increment("email_outbound_total", {
    result: decision.to.toLowerCase(),
    reason: decision.to === "FAILED" ? decision.reason : undefined,
  });
  await publishDeliveryChanged(row);
  log.info(
    { organizationId, sendId: id, attempt, to: decision.to },
    "outbound email state recorded",
  );
  return true;
}

/** The provider payload. The text is read from `messages` now: it is not copied into the send row. */
async function buildPayload(
  row: OutboundEmailRow,
): Promise<
  { ok: true; email: OutboundEmail } | { ok: false; code: string; reason: FailureReason }
> {
  const settings = await outboundEmailRepository.settingsForSend(
    row.organizationId,
    row.emailSettingsId,
  );
  // The organization may have switched email off, or changed its address, after this send was queued: never send
  // from an address that is no longer the organization's verified one.
  if (
    !settings ||
    !settings.enabled ||
    settings.status !== "ACTIVE" ||
    settings.supportAddress !== row.fromAddress
  ) {
    return { ok: false, code: "sender_unavailable", reason: "sender_unavailable" };
  }
  const message = await outboundEmailRepository.messageForSend(
    row.organizationId,
    row.conversationId,
    row.messageId,
  );
  if (!message || message.messageType !== "MESSAGE" || message.senderType !== "USER") {
    return { ok: false, code: "message_missing", reason: "message_missing" };
  }
  return {
    ok: true,
    email: {
      from: { address: row.fromAddress, name: row.fromName },
      to: row.toAddress,
      subject: row.subject,
      text: message.body,
      messageId: row.rfcMessageId,
      inReplyTo: row.inReplyTo,
      references: row.references,
      // The send id is the provider idempotency key: identical on every attempt of this logical email.
      idempotencyKey: row.id,
    },
  };
}

/**
 * One claimed attempt: call the provider (bounded) and record exactly what we know.
 *
 * Why the lease guard and the settle logic exist (Phase 9.6). Abandoning a request after `sendTimeoutMs` does NOT cancel
 * it: the provider may still accept it later, and a worker may even be frozen between claiming and calling. So:
 *  - a call is only STARTED while at least the provider's settle window of the lease remains. Then, by the time any lease
 *    has expired, every call made under it has had the whole window to land and to become visible to the lookup, which
 *    is what lets recovery believe a "not found" (`recoverExpired`);
 *  - after an ambiguous result a "not found" is believed immediately only when the window has already passed (an
 *    idempotent provider, or a strongly consistent lookup with no late acceptance); otherwise the send STAYS PROCESSING
 *    and recovery asks again after the lease expired. Nothing is resent in the meantime.
 */
async function attemptDelivery(
  row: OutboundEmailRow,
  provider: EmailProvider,
  deps: OutboundDeps,
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  // Two different numbers, never to be mixed: `attempt` is the OWNERSHIP counter (the fence: every claim and every
  // takeover increments it); `logical` is the delivery attempt whose result is being decided (retries scheduled so far,
  // plus this one). Backoff and the retry budget depend on `logical` only, so recovery checks cannot exhaust them.
  const attempt = row.attempts;
  const logical = row.retries + 1;
  const maxAttempts = deps.maxAttempts ?? OUTBOUND_POLICY.maxAttempts;
  const timeoutMs = deps.sendTimeoutMs ?? OUTBOUND_POLICY.sendTimeoutMs;

  const payload = await buildPayload(row);
  if (!payload.ok) {
    // Decided before the provider was involved, so it is a definite, final failure.
    await applyDecision(
      row,
      attempt,
      { to: "FAILED", code: payload.code, reason: payload.reason },
      { now },
    );
    return;
  }

  // A call may only START while at least the provider's settle window of the lease remains: then an expired lease means
  // the window has passed (see `leaseFor`). A claim that waited too long (a slow database, a paused process) extends its
  // OWN lease first, fenced by the attempt number: if recovery already took the send over the extension is refused and no
  // call is made. Nothing is consumed and nothing is sent by that path.
  const window = settleWindowMs(provider.sending);
  let leaseUntil = row.leaseUntil;
  if (!leaseUntil || now().getTime() + window > leaseUntil.getTime()) {
    const extended = new Date(now().getTime() + leaseFor(provider.sending, timeoutMs));
    const ok = await outboundEmailRepository
      .extendLease(row.id, row.organizationId, attempt, extended, now())
      .catch(() => false);
    if (!ok) {
      metrics.increment("email_outbound_total", { result: "lease_extend_refused" });
      log.warn(
        { organizationId: row.organizationId, sendId: row.id, attempt },
        "could not extend the lease before a provider call (taken over, or the database failed): no call made",
      );
      return;
    }
    metrics.increment("email_outbound_total", { result: "lease_extended" });
    leaseUntil = extended;
  }
  // The FINAL check: synchronous with the call below (nothing is awaited between them), against the lease this worker
  // holds. What remains is the unavoidable gap of a process frozen by the OS in between, covered only by the provider's
  // idempotency or its declared late-acceptance ceiling plus the lease margin (see docs/email-outbound.md).
  const startedAt = now();
  if (startedAt.getTime() + window > leaseUntil.getTime()) {
    metrics.increment("email_outbound_total", { result: "lease_too_short" });
    await applyDecision(
      row,
      attempt,
      {
        to: "RETRY_SCHEDULED",
        code: "lease_too_short",
        delayMs: backoffMs(logical, deps.random),
        noCall: true,
      },
      { now },
    );
    return;
  }

  const controller = new AbortController();
  let result: SendResult | "timeout";
  try {
    result = await withTimeout(
      provider.sendEmail(payload.email, { signal: controller.signal }),
      timeoutMs,
    );
  } catch {
    // The contract says adapters do not throw; if one does we cannot know whether the request left.
    result = { ok: false, ambiguous: true, code: "adapter_exception" };
  }
  if (result === "timeout") {
    // Ask the adapter to drop the request. Whether it did is irrelevant to correctness: the request may already have
    // been read by the provider, so nothing below assumes it was cancelled.
    controller.abort();
    result = { ok: false, ambiguous: true, code: "timeout" };
  }

  if (!result.ok && result.ambiguous) {
    const askedAt = now();
    const lookup = await lookupByKey(provider, row.id, timeoutMs);
    const decision = decideAmbiguous({
      code: result.code,
      lookup,
      capabilities: provider.sending,
      attempt: logical,
      settledForMs: askedAt.getTime() - startedAt.getTime(),
      sinceClaimMs: askedAt.getTime() - (row.lastAttemptAt ?? startedAt).getTime(),
      random: deps.random,
      maxAttempts,
    });
    metrics.increment("email_outbound_total", {
      result: "ambiguous",
      reason: sanitizeErrorCode(result.code),
    });
    if (decision.to === "AWAIT_SETTLE") {
      metrics.increment("email_outbound_total", { result: "settle_pending" });
      log.info(
        { organizationId: row.organizationId, sendId: row.id, attempt },
        "ambiguous email attempt: waiting for the provider settle window before believing a lookup",
      );
      return;
    }
    await applyDecision(row, attempt, decision, { now });
    return;
  }
  await applyDecision(
    row,
    attempt,
    decideAfterAttempt(
      result as Exclude<SendResult, { ok: false; ambiguous: true }>,
      logical,
      deps.random,
      maxAttempts,
    ),
    { now },
  );
}

/**
 * The queue handler: a wake-up for one send. Everything is decided from the database. It is idempotent and safe to
 * run twice or concurrently: only the worker whose conditional claim succeeds calls the provider. It does not
 * throw for provider outcomes (they are recorded as state); only an unexpected database error propagates, which
 * the queue retries.
 */
export async function processEmailSendJob(
  job: EmailSendJob,
  deps: OutboundDeps = {},
): Promise<void> {
  const now = deps.now ?? (() => new Date());
  const skip = (reason: string) => {
    metrics.increment("email_outbound_total", { result: "skipped", reason });
    log.info(
      { organizationId: job.organizationId, sendId: job.sendId, reason },
      "email send skipped",
    );
  };

  // The job names an organization; the send must belong to it (a forged or stale job finds nothing).
  const row = await outboundEmailRepository.find(job.sendId, job.organizationId);
  if (!row) return skip("not_found");
  if (row.status !== "PENDING" && row.status !== "RETRY_SCHEDULED") return skip("not_claimable");
  if (row.nextAttemptAt.getTime() > now().getTime()) return skip("not_due");

  const provider = usableProvider();
  if (!provider) return skip("provider_unavailable");

  const claimed = await outboundEmailRepository.claim(
    row.id,
    row.organizationId,
    now(),
    new Date(
      now().getTime() +
        (deps.leaseMs ??
          leaseFor(provider.sending, deps.sendTimeoutMs ?? OUTBOUND_POLICY.sendTimeoutMs)),
    ),
  );
  if (!claimed) return skip("lost_claim");
  await attemptDelivery(claimed, provider, deps);
}

// ---- recovery -----------------------------------------------------------------------------------------

/**
 * A PROCESSING send whose lease ran out: its worker died or hung, and nobody knows whether the provider call
 * happened. Take the send over (attempts + 1, which makes the dead worker's token stale) and resolve it as an
 * unknown outcome: ask the provider if it can be asked, retry only when that cannot duplicate, else UNKNOWN.
 */
async function recoverExpired(
  send: { id: string; organizationId: string },
  provider: EmailProvider,
  deps: OutboundDeps,
): Promise<boolean> {
  const now = deps.now ?? (() => new Date());
  const taken = await outboundEmailRepository.takeOverExpired(
    send.id,
    send.organizationId,
    now(),
    new Date(now().getTime() + (deps.leaseMs ?? OUTBOUND_POLICY.leaseMs)),
  );
  if (!taken) return false;
  // The takeover does not touch `lastAttemptAt`: it still says when the dead attempt was CLAIMED, an upper bound of how
  // long ago its request was sent (for the lookup's retention). Because a call only starts with the settle window left
  // on its lease, the expired lease already implies the window has passed; the age since the claim is a second,
  // independent check of that (it also catches a lease that was shorter than the window).
  const askedAt = now();
  const claimedAt = taken.lastAttemptAt ?? askedAt;
  const sinceClaimMs = askedAt.getTime() - claimedAt.getTime();
  const lookup = await lookupByKey(
    provider,
    taken.id,
    deps.sendTimeoutMs ?? OUTBOUND_POLICY.sendTimeoutMs,
  );
  const decision = decideAmbiguous({
    code: "lease_expired",
    lookup,
    capabilities: provider.sending,
    // The budget attempt that was lost with the dead worker, NOT the ownership counter (which the takeover just moved).
    attempt: taken.retries + 1,
    settledForMs: sinceClaimMs,
    sinceClaimMs,
    random: deps.random,
    maxAttempts: deps.maxAttempts,
  });
  metrics.increment("email_outbound_total", {
    result: "recovered",
    reason: decision.to.toLowerCase(),
  });
  if (decision.to === "AWAIT_SETTLE") {
    // Stay PROCESSING, but under a lease that ends when the window does: one more check then, not one per lease. (The
    // takeover itself consumed no retry budget; only a scheduled retry does.)
    await outboundEmailRepository
      .extendLease(
        taken.id,
        taken.organizationId,
        taken.attempts,
        new Date(askedAt.getTime() + decision.remainingMs + LEASE_MARGIN_MS),
        askedAt,
      )
      .catch(() => false);
  } else {
    await applyDecision(taken, taken.attempts, decision, { now });
  }
  return true;
}

export type OutboundReconcileResult = { recovered: number; wokenUp: number };

/**
 * The worker's pass over outbound email: (1) resolve attempts whose worker died; (2) queue a wake-up for every
 * send that is due, which also recreates a job that was never queued, was lost with Redis, or whose retry time has
 * arrived (retries are scheduled in the database, so they survive restarts; their latency is bounded by the
 * maintenance interval). Safe from any number of workers: claims are atomic and wake-ups are idempotent.
 */
export async function reconcileOutboundEmail(
  options: { limit?: number } & OutboundDeps = {},
): Promise<OutboundReconcileResult> {
  const now = (options.now ?? (() => new Date()))();
  const limit = options.limit ?? 100;
  const result: OutboundReconcileResult = { recovered: 0, wokenUp: 0 };
  const provider = usableProvider();

  if (provider) {
    for (const send of await outboundEmailRepository.listExpired(limit, now)) {
      if (await recoverExpired(send, provider, options)) result.recovered++;
    }
  }
  // Without a usable provider nothing can be delivered (the job would skip), so waking up would only spin.
  if (provider) {
    for (const send of await outboundEmailRepository.listDue(limit, now)) {
      if (await wakeUp(send)) result.wokenUp++;
    }
  }
  return result;
}
