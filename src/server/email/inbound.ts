import { isUniqueViolation } from "@/db/errors";
import { transaction } from "@/db/client";
import type { EmailHoldReason, Prisma } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import {
  publishRecordedEvents,
  recordDomainEvent,
  type RecordedEvent,
} from "@/server/events/outbox";
import { metrics } from "@/server/observability/metrics";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { customersRepository } from "@/server/repositories/customers";
import { conversationsRepository } from "@/server/repositories/conversations";
import { emailInboundRepository } from "@/server/repositories/email-inbound";
import {
  persistMessageInTransaction,
  type PersistedMessage,
} from "@/server/services/conversation-messages";
import {
  createConversationInTransaction,
  type CreatedConversation,
} from "@/server/services/conversations";
import type { Actor } from "@/server/services/actors";
import { normalizeEmailAddress } from "./address";
import {
  cleanAddressList,
  cleanAttachments,
  cleanBody,
  cleanDisplayName,
  cleanSubject,
  displayFirstName,
  isSystemSender,
  rawSubject,
  validRfcId,
  validRfcIds,
} from "./inbound-content";
import { getEmailPlatformDomain } from "./index";
import { normalizedInboundEmailSchema, type NormalizedInboundEmail } from "./provider";
import { evaluateSenderAuth } from "./sender-auth";

const log = createLogger("email-inbound");

/**
 * Abuse bounds. A single organization address is public by nature (anybody can write to it), so volume is
 * limited per organization and per sender, and the review queue is capped. Beyond a bound the email is
 * dropped (acknowledged, never retried) rather than stored.
 */
export const INBOUND_LIMITS: {
  windowMs: number;
  perOrganization: number;
  perSender: number;
  openHeldPerOrganization: number;
  /**
   * Open held mail per reason. Together they stay within `openHeldPerOrganization`, so a flood of one kind
   * (typically spoofed, unauthenticated mail, the cheapest to produce) can never use up the review queue that
   * legitimate held mail (an archived customer writing again, an ambiguous thread) needs.
   */
  openHeldByReason: Record<EmailHoldReason, number>;
  /** One email can name several of our addresses; it is delivered to at most this many organizations. */
  organizationsPerEmail: number;
} = {
  windowMs: 60 * 60 * 1000,
  perOrganization: 500,
  perSender: 20,
  openHeldPerOrganization: 200,
  openHeldByReason: {
    UNAUTHENTICATED_SENDER: 100,
    ARCHIVED_CUSTOMER: 50,
    AMBIGUOUS_THREAD: 25,
    THREAD_SENDER_MISMATCH: 25,
  },
  organizationsPerEmail: 5,
};

export type IgnoreReason =
  | "malformed_message"
  | "invalid_sender"
  | "loop"
  | "automated"
  | "unknown_recipient"
  | "rate_limited_organization"
  | "rate_limited_sender"
  | "held_limit"
  | "held_limit_reason";

export type InboundResult =
  | {
      status: "processed";
      organizationId: string;
      conversationId: string;
      messageId: string;
      newConversation: boolean;
      newCustomer: boolean;
    }
  | { status: "held"; organizationId: string; reason: EmailHoldReason }
  | { status: "ignored"; reason: IgnoreReason }
  | { status: "duplicate"; organizationId: string };

/**
 * Turns one verified, fetched inbound email into messages. The organization is decided ONLY by looking the
 * envelope recipients up in the enabled, verified support addresses (trusted server-side configuration);
 * nothing in the email chooses a tenant, a customer id or a conversation id.
 *
 * Returns one result per organization the email was delivered to (usually one).
 */
export async function ingestInboundEmail(raw: NormalizedInboundEmail): Promise<InboundResult[]> {
  const parsed = normalizedInboundEmailSchema.safeParse(raw);
  if (!parsed.success) return [{ status: "ignored", reason: "malformed_message" }];
  const email = parsed.data;

  const from = normalizeEmailAddress(email.from);
  if (!from) return [{ status: "ignored", reason: "invalid_sender" }];

  // Mail loops: never process mail from our own domain (our outbound mail, an organization's own address),
  // from mail systems, or anything the provider flagged as automated (auto-replies, bounces, lists).
  const platformDomain = getEmailPlatformDomain();
  if (platformDomain && from.endsWith(`@${platformDomain}`)) {
    return [{ status: "ignored", reason: "loop" }];
  }
  if (email.automated || isSystemSender(from)) return [{ status: "ignored", reason: "automated" }];

  const recipients = [
    ...new Set(email.deliveredTo.flatMap((address) => normalizeEmailAddress(address) ?? [])),
  ];
  const targets = (await emailInboundRepository.findDeliveryTargets(recipients)).slice(
    0,
    INBOUND_LIMITS.organizationsPerEmail,
  );
  if (targets.length === 0) return [{ status: "ignored", reason: "unknown_recipient" }];

  const results: InboundResult[] = [];
  for (const target of targets) {
    results.push(await ingestForOrganization(target.organizationId, email, from));
  }
  return results;
}

type Stored = {
  kind: "stored";
  conversationId: string;
  customerId: string;
  customerCreated: boolean;
  /** The durable events of this ingestion, recorded in the transaction (customer, conversation, message). */
  customerEvent: RecordedEvent | null;
  conversation: CreatedConversation | null;
  persisted: PersistedMessage;
  actor: Actor;
};
type Held =
  | { kind: "held"; reason: EmailHoldReason }
  | { kind: "held_limit"; scope: "queue" | "reason"; reason: EmailHoldReason };
type Skipped = { kind: "duplicate" } | { kind: "ignored"; reason: IgnoreReason };

/** Counts the outcome (labels are codes and the organization id only: never an address or content). */
function observe(organizationId: string, result: InboundResult): InboundResult {
  metrics.increment("email_inbound_total", {
    outcome: result.status,
    reason:
      result.status === "held" || result.status === "ignored"
        ? result.reason.toLowerCase()
        : undefined,
    organizationId,
  });
  return result;
}

async function ingestForOrganization(
  organizationId: string,
  email: NormalizedInboundEmail,
  from: string,
): Promise<InboundResult> {
  return observe(
    organizationId,
    await ingestForOrganizationUnobserved(organizationId, email, from),
  );
}

async function ingestForOrganizationUnobserved(
  organizationId: string,
  email: NormalizedInboundEmail,
  from: string,
): Promise<InboundResult> {
  // A cheap early shed (no lock, no write) so a flood beyond the bounds never queues on the organization
  // lock. These checks are NOT the guarantee: the same checks run again, serialized, inside the transaction.
  const early = await checkAdmission(organizationId, email, from);
  if (early) return toResult(organizationId, early);

  // Two attempts: a concurrent first email of the same sender may create the customer between our lookup
  // and our insert; the second attempt then simply finds that customer.
  for (let attempt = 0; ; attempt++) {
    try {
      const outcome = await transaction((tx) =>
        storeInTransaction(tx, organizationId, email, from),
      );
      if (outcome.kind === "held") {
        log.info({ organizationId, reason: outcome.reason }, "inbound email held for review");
        return { status: "held", organizationId, reason: outcome.reason };
      }
      if (outcome.kind === "held_limit") {
        // Saturation is the early warning that legitimate held mail is about to be dropped.
        log.warn(
          { organizationId, scope: outcome.scope },
          "inbound email dropped: review queue full",
        );
        metrics.increment("email_held_queue_saturated_total", {
          organizationId,
          scope: outcome.scope,
          reason: outcome.reason.toLowerCase(),
        });
        return {
          status: "ignored",
          reason: outcome.scope === "queue" ? "held_limit" : "held_limit_reason",
        };
      }
      if (outcome.kind === "duplicate" || outcome.kind === "ignored") {
        return toResult(organizationId, outcome);
      }
      // The message is committed. Announcing it (realtime, automations) is best effort and must never turn a
      // stored message into a failed request: a retry would find a duplicate and could not announce it anyway.
      try {
        await announceStored(organizationId, outcome);
      } catch (error) {
        log.error(
          {
            organizationId,
            conversationId: outcome.conversationId,
            err: error instanceof Error ? error.name : "unknown",
          },
          "announcing a stored inbound email failed",
        );
      }
      return {
        status: "processed",
        organizationId,
        conversationId: outcome.conversationId,
        messageId: outcome.persisted.message.id,
        newConversation: outcome.conversation !== null,
        newCustomer: outcome.customerCreated,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // The same provider message won a race (a concurrent delivery of the same notification).
      if (await emailInboundRepository.isKnown(organizationId, email.providerMessageId)) {
        return { status: "duplicate", organizationId };
      }
      if (attempt >= 1) throw error;
    }
  }
}

function toResult(organizationId: string, skipped: Skipped): InboundResult {
  if (skipped.kind === "duplicate") return { status: "duplicate", organizationId };
  return { status: "ignored", reason: skipped.reason };
}

/** Already seen, or over a bound? Reads only; callable with or without the organization lock. */
async function checkAdmission(
  organizationId: string,
  email: NormalizedInboundEmail,
  from: string,
  db?: Prisma.TransactionClient,
): Promise<Skipped | null> {
  if (await emailInboundRepository.isKnown(organizationId, email.providerMessageId, db)) {
    return { kind: "duplicate" };
  }
  const since = new Date(Date.now() - INBOUND_LIMITS.windowMs);
  if (
    (await emailInboundRepository.countReceivedSince(organizationId, since, db)) >=
    INBOUND_LIMITS.perOrganization
  ) {
    log.warn({ organizationId }, "inbound email dropped: organization limit");
    metrics.increment("email_quota_exhausted_total", { scope: "organization", organizationId });
    return { kind: "ignored", reason: "rate_limited_organization" };
  }
  if (
    (await emailInboundRepository.countFromSenderSince(organizationId, from, since, db)) >=
    INBOUND_LIMITS.perSender
  ) {
    log.warn({ organizationId }, "inbound email dropped: sender limit");
    metrics.increment("email_quota_exhausted_total", { scope: "sender", organizationId });
    return { kind: "ignored", reason: "rate_limited_sender" };
  }
  return null;
}

/**
 * Everything that must commit together: the customer (if new), the conversation (if new), the message
 * with the shared lifecycle rules (reopen on reply, preview, events), and the email record. Domain events
 * are announced by the caller after the commit.
 */
async function storeInTransaction(
  tx: Prisma.TransactionClient,
  organizationId: string,
  email: NormalizedInboundEmail,
  from: string,
): Promise<Stored | Held | Skipped> {
  // One inbound email per organization at a time. The caps (hourly volume, per sender, review queue) and the
  // duplicate check are count-then-insert, which is only exact when nothing else inserts in between; this
  // transaction-scoped advisory lock (released at commit/rollback, per organization, so tenants never wait for
  // each other) makes them exact. It also serializes concurrent replies to one conversation.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email-inbound:${organizationId}`}, 0))`;
  const skipped = await checkAdmission(organizationId, email, from, tx);
  if (skipped) return skipped;

  const body = cleanBody(email.text);
  const subject = rawSubject(email.subject);
  const inReplyTo = validRfcId(email.inReplyTo);
  const references = validRfcIds(email.references);
  const messageId = validRfcId(email.messageId);
  const attachments = cleanAttachments(email.attachments);
  // Everything stored from the headers is cleaned: a control character in a stored value would later be copied
  // into a mail header (outbound) or break the insert, and a NUL byte would make the database reject the row.
  const fromName = cleanDisplayName(email.fromName);
  const toAddresses = cleanAddressList(email.to);
  const ccAddresses = cleanAddressList(email.cc);

  const auth = evaluateSenderAuth(from, email.senderAuth);

  const hold = async (reason: EmailHoldReason): Promise<Held> => {
    if (
      (await emailInboundRepository.countOpenHeld(organizationId, undefined, tx)) >=
      INBOUND_LIMITS.openHeldPerOrganization
    ) {
      return { kind: "held_limit", scope: "queue", reason };
    }
    if (
      (await emailInboundRepository.countOpenHeld(organizationId, reason, tx)) >=
      INBOUND_LIMITS.openHeldByReason[reason]
    ) {
      return { kind: "held_limit", scope: "reason", reason };
    }
    await emailInboundRepository.createHeld(
      {
        organizationId,
        reason,
        providerMessageId: email.providerMessageId,
        rfcMessageId: messageId,
        inReplyTo,
        references,
        fromAddress: from,
        fromName,
        toAddresses,
        ccAddresses,
        subject,
        body,
        spf: auth.spf,
        dkim: auth.dkim,
        authDetail: auth.detail,
        attachments,
        receivedAt: email.receivedAt,
      },
      tx,
    );
    return { kind: "held", reason };
  };

  // 1. A sender whose SPF or DKIM did not pass FOR THE FROM DOMAIN is never matched to anybody's record.
  //    (The adapter reports which domains passed; alignment is decided here, see sender-auth.ts.)
  if (!auth.authenticated) return hold("UNAUTHENTICATED_SENDER");

  // 2. Threading: RFC headers only, looked up inside THIS organization (a Message-ID of another tenant is
  //    simply unknown here). The subject is never used.
  let threadConversationId: string | null = null;
  for (const ids of [inReplyTo ? [inReplyTo] : [], references]) {
    if (threadConversationId || ids.length === 0) continue;
    const found = await emailInboundRepository.findConversationsByRfcIds(organizationId, ids, tx);
    const distinct = [...new Set(found.map((row) => row.conversationId))];
    if (distinct.length > 1) return hold("AMBIGUOUS_THREAD");
    if (distinct.length === 1) threadConversationId = distinct[0];
  }

  // 3. The sender's customer record (the address is unique per organization, so a match is exact).
  const existing = await customersRepository.findByEmailForRouting(organizationId, from, tx);
  if (existing?.status === "ARCHIVED") return hold("ARCHIVED_CUSTOMER");

  let conversationId = threadConversationId;
  if (conversationId) {
    const state = await conversationsRepository.findState(organizationId, conversationId, tx);
    // A thread belongs to its customer. Someone else quoting its headers (a colleague, or an attacker who
    // saw a Message-ID) must not write into it.
    if (!state || !existing || state.customerId !== existing.id) {
      return hold("THREAD_SENDER_MISMATCH");
    }
  }

  let customerId = existing?.id ?? null;
  let customerCreated = false;
  let customerEvent: RecordedEvent | null = null;
  if (!customerId) {
    const created = await customersRepository.create(
      organizationId,
      {
        externalId: null,
        firstName: displayFirstName(email.fromName, from),
        lastName: null,
        email: from,
        phone: null,
        company: null,
        jobTitle: null,
        source: "email",
        status: "ACTIVE",
      },
      tx,
    );
    await customerActivitiesRepository.record(
      organizationId,
      created.id,
      {
        type: "CUSTOMER_CREATED",
        title: "Customer created from an email",
        metadata: { source: "email" },
        actorType: "SYSTEM",
        actorId: null,
      },
      tx,
    );
    customerEvent = await recordDomainEvent(tx, {
      organizationId,
      actorUserId: null,
      type: "customer.created",
      data: { customerId: created.id, status: "ACTIVE", company: null, source: "email" },
    });
    customerId = created.id;
    customerCreated = true;
  }

  const actor: Actor = { kind: "email", customerId };
  let conversation: CreatedConversation | null = null;
  if (!conversationId) {
    conversation = await createConversationInTransaction(tx, {
      organizationId,
      actor,
      // Email conversations are always handled by people: no automatic AI replies on this channel.
      handlingMode: "HUMAN",
      input: {
        customerId,
        subject: cleanSubject(email.subject),
        priority: "NORMAL",
        channel: "EMAIL",
      },
    });
    conversationId = conversation.conversation.id;
  }

  const persisted = await persistMessageInTransaction(tx, {
    organizationId,
    actor,
    conversationId,
    input: { body, type: "MESSAGE", from: "CUSTOMER" },
  });
  await emailInboundRepository.createEmailMessage(
    {
      organizationId,
      conversationId,
      messageId: persisted.message.id,
      direction: "INBOUND",
      providerMessageId: email.providerMessageId,
      rfcMessageId: messageId,
      inReplyTo,
      references,
      fromAddress: from,
      fromName,
      toAddresses,
      ccAddresses,
      subject,
      spf: auth.spf,
      dkim: auth.dkim,
      authDetail: auth.detail,
      attachments,
      receivedAt: email.receivedAt,
    },
    tx,
  );

  return {
    kind: "stored",
    conversationId,
    customerId,
    customerCreated,
    customerEvent,
    conversation,
    persisted,
    actor,
  };
}

/**
 * After the commit: logs and publishes the events recorded in the transaction (customer, conversation, message),
 * in that order. They are durable: anything that cannot be published now stays in the outbox and is retried.
 */
async function announceStored(organizationId: string, stored: Stored): Promise<void> {
  log.info(
    {
      organizationId,
      conversationId: stored.conversationId,
      messageId: stored.persisted.message.id,
      actor: stored.actor.kind,
      newConversation: stored.conversation !== null,
      newCustomer: stored.customerCreated,
    },
    "inbound email stored",
  );
  await publishRecordedEvents([
    ...(stored.customerEvent ? [stored.customerEvent] : []),
    ...(stored.conversation ? [stored.conversation.event] : []),
    ...stored.persisted.events,
  ]);
}
