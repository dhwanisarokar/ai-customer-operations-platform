import { transaction } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError, ValidationError } from "@/server/errors";
import { metrics } from "@/server/observability/metrics";
import { outboundEmailAuditRepository } from "@/server/repositories/outbound-email-audit";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { toDeliveryDto, type DeliveryFailure, type MessageDeliveryDto } from "./delivery-state";
import { lookupByKey, usableProvider } from "./outbound";
import { OUTBOUND_POLICY, leaseFor, lookupTrusted, settleWindowMs } from "./outbound-state";
import type { EmailProvider } from "./provider";

const log = createLogger("email-outbound-ops");

/**
 * Operational safety for outbound email (Phase 9.4): what staff of ONE organization may see about sends that need
 * attention, and the only ways out of an UNKNOWN outcome. Read `outbound-state.ts` first for why UNKNOWN exists.
 *
 * Authorization model (there is NO platform-operator role in this system; every role is organization-scoped):
 *   - viewing and re-checking: `manage_email` (ADMIN and OWNER) of the organization, for THAT organization's sends only;
 *   - a re-check never lets the person decide the outcome: the SYSTEM asks the provider and records what it answers;
 *   - an operator attestation ("it was not sent") is NOT reachable over HTTP at all. It is a server-side function used
 *     by a person with production access (`npm run email:resolve-unknown`), with identity and reason audited;
 *   - nothing here can mark an email as sent on someone's say-so, and nothing here resends.
 */

// ---- thresholds (explicit; see docs/email-operations.md) -------------------------------------------------

export const ATTENTION = {
  /**
   * A waiting send (PENDING / RETRY_SCHEDULED) is "overdue" once its time came this long ago and nobody has taken it.
   * The worker's pass runs every minute, so ten minutes means the worker is stopped or cannot reach the provider; an
   * ordinary retry that is waiting for its scheduled time is never listed.
   */
  overdueMs: 10 * 60 * 1000,
  /**
   * An in-flight send whose lease expired is "stalled" after this much longer. Recovery runs every minute, so a short
   * overrun is the reconciler about to resolve it; beyond two minutes nothing is recovering it.
   */
  leaseExpiredGraceMs: 2 * 60 * 1000,
  /** Failed sends stay in the view this long. */
  failedWindowMs: 30 * 24 * 3600 * 1000,
  /**
   * The FLOOR of how old the last attempt must be before an UNKNOWN send is resolved (by re-check or by an operator). It
   * is an operational minimum, NOT provider evidence: the real requirement is derived from what the provider declares
   * (`resolveGuardMs`: the claim's lease plus the provider's settle window), and the larger of the two applies. A
   * provider call that hung can still complete after we gave up, and a lookup can lag behind an acceptance.
   */
  minAgeToResolveMs: 10 * 60 * 1000,
  maxPageSize: 50,
} as const;

export type AttentionCategory =
  "queued_overdue" | "retry_overdue" | "lease_expired" | "unknown" | "failed";

export const ATTENTION_CATEGORIES: readonly AttentionCategory[] = [
  "queued_overdue",
  "retry_overdue",
  "lease_expired",
  "unknown",
  "failed",
];

function whereFor(category: AttentionCategory, now: Date): Prisma.OutboundEmailWhereInput {
  switch (category) {
    case "queued_overdue":
      return {
        status: "PENDING",
        nextAttemptAt: { lte: new Date(now.getTime() - ATTENTION.overdueMs) },
      };
    case "retry_overdue":
      return {
        status: "RETRY_SCHEDULED",
        nextAttemptAt: { lte: new Date(now.getTime() - ATTENTION.overdueMs) },
      };
    case "lease_expired":
      return {
        status: "PROCESSING",
        leaseUntil: { lte: new Date(now.getTime() - ATTENTION.leaseExpiredGraceMs) },
      };
    case "unknown":
      return { status: "UNKNOWN" };
    case "failed":
      return {
        status: "FAILED",
        failedAt: { gte: new Date(now.getTime() - ATTENTION.failedWindowMs) },
      };
  }
}

/** "e***@customer.test": enough to recognise the customer, never the full address. */
export function maskAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${address[0]}***${address.slice(at)}`;
}

export type AttentionItem = {
  id: string;
  conversationId: string;
  messageId: string;
  category: AttentionCategory;
  /** The coarse delivery state staff already see in the inbox. */
  state: MessageDeliveryDto["state"];
  /** Since when it has needed attention (when it became overdue, unknown or failed). */
  since: Date;
  failure: DeliveryFailure | null;
  /** Masked: never the full address. */
  recipient: string;
  /** UNKNOWN only: whether the provider can be asked right now (the re-check action). */
  canRecheck: boolean;
};

export type AttentionPage = {
  items: AttentionItem[];
  total: number;
  page: number;
  pageSize: number;
  /** How many sends are in each category (bounded counts, always for the whole organization). */
  summary: Record<AttentionCategory, number>;
};

function categoryOf(row: {
  status: string;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
}): { category: AttentionCategory; since: Date } | null {
  switch (row.status) {
    case "PENDING":
      return { category: "queued_overdue", since: row.nextAttemptAt };
    case "RETRY_SCHEDULED":
      return { category: "retry_overdue", since: row.nextAttemptAt };
    case "PROCESSING":
      return row.leaseUntil ? { category: "lease_expired", since: row.leaseUntil } : null;
    default:
      return null;
  }
}

/**
 * The sends of the caller's organization that need attention, from persisted state only. Bounded (page size is capped,
 * counts are per category), oldest first. Normal work is deliberately absent: a send that is queued, being delivered or
 * waiting for its scheduled retry is not listed, only work that is overdue, stalled, unknown or failed.
 */
export async function listAttention(
  ctx: OrganizationContext,
  query: { page?: number; pageSize?: number; category?: AttentionCategory },
  now: Date = new Date(),
): Promise<AttentionPage> {
  ctx.require("manage_email");
  const organizationId = ctx.organization.id;
  const page = Math.max(1, Math.floor(query.page ?? 1));
  const pageSize = Math.min(ATTENTION.maxPageSize, Math.max(1, Math.floor(query.pageSize ?? 20)));
  const categories = query.category ? [query.category] : ATTENTION_CATEGORIES;
  const where: Prisma.OutboundEmailWhereInput = { OR: categories.map((c) => whereFor(c, now)) };

  const [{ items, total }, counts] = await Promise.all([
    outboundEmailRepository.attention(organizationId, { where, page, pageSize }),
    Promise.all(
      ATTENTION_CATEGORIES.map((c) =>
        outboundEmailRepository.countWhere(organizationId, whereFor(c, now)),
      ),
    ),
  ]);
  const provider = usableProvider();
  const canAsk = Boolean(provider && lookupTrusted(provider.sending) && provider.findSendByKey);

  return {
    items: items.map((row): AttentionItem => {
      const waiting = categoryOf(row);
      const dto = toDeliveryDto({
        status: row.status,
        nextAttemptAt: row.nextAttemptAt,
        sentAt: null,
        failedAt: row.failedAt,
        finalReason: row.finalReason,
      });
      const category: AttentionCategory =
        waiting?.category ?? (row.status === "UNKNOWN" ? "unknown" : "failed");
      const since =
        waiting?.since ??
        (row.status === "FAILED" ? (row.failedAt ?? row.updatedAt) : row.updatedAt);
      return {
        id: row.id,
        conversationId: row.conversationId,
        messageId: row.messageId,
        category,
        state: dto.state,
        since,
        failure: dto.failure,
        recipient: maskAddress(row.toAddress),
        canRecheck: row.status === "UNKNOWN" && canAsk,
      };
    }),
    total,
    page,
    pageSize,
    summary: Object.fromEntries(ATTENTION_CATEGORIES.map((c, i) => [c, counts[i]])) as Record<
      AttentionCategory,
      number
    >,
  };
}

// ---- resolving UNKNOWN ------------------------------------------------------------------------------------

export type RecheckResult = {
  /**
   * found: the provider has it (now SENT); no_record: the provider has none and that answer is believable (now FAILED,
   * NOT resent); unavailable: the provider could not answer (still UNKNOWN); inconclusive: it answered "no record" but
   * the lookup no longer remembers that far back, so that proves nothing (still UNKNOWN).
   */
  outcome: "found" | "no_record" | "unavailable" | "inconclusive";
  delivery: MessageDeliveryDto;
};

type Deps = { now?: () => Date; sendTimeoutMs?: number };

/**
 * How old the last attempt's CLAIM must be before an UNKNOWN send may be resolved: the operational floor, or the provider's
 * own timing when that is longer. A request is only ever started with the settle window left on its lease, so it has
 * fully landed (and become visible to the lookup) once `lease + window` has passed since the claim.
 */
export function resolveGuardMs(
  provider: Pick<EmailProvider, "sending"> | null,
  sendTimeoutMs: number = OUTBOUND_POLICY.sendTimeoutMs,
): number {
  if (!provider) return ATTENTION.minAgeToResolveMs;
  const c = provider.sending;
  return Math.max(ATTENTION.minAgeToResolveMs, leaseFor(c, sendTimeoutMs) + settleWindowMs(c));
}

function tooRecent(lastAttemptAt: Date | null, now: Date, guardMs: number): boolean {
  return lastAttemptAt !== null && now.getTime() - lastAttemptAt.getTime() < guardMs;
}

/**
 * Asks the PROVIDER what happened to an UNKNOWN send, and records only what the provider says. The caller cannot choose
 * the outcome. Needs a provider that declares an authoritative lookup (`sending.lookupByKey`); a provider without one
 * cannot be asked, and the send stays UNKNOWN (409). It never resends.
 *
 *   found      -> SENT, with the provider message id the PROVIDER returned (acceptance, not delivery)
 *   not found  -> FAILED "provider_has_no_record" (it was not sent; a new reply would be a new email), but ONLY while
 *                 the lookup still remembers (`lookupRetentionMs`): older than that, "not found" means "forgotten"
 *   unavailable-> unchanged (audited, so repeated attempts are visible)
 *   forgotten  -> unchanged ("inconclusive", audited like unavailable)
 *
 * Refused while the last attempt is recent (a hung provider call can still complete, a lookup can lag): `resolveGuardMs`.
 */
export async function recheckUnknown(
  ctx: OrganizationContext,
  sendId: string,
  deps: Deps = {},
): Promise<RecheckResult> {
  ctx.require("manage_email");
  const organizationId = ctx.organization.id;
  const now = (deps.now ?? (() => new Date()))();

  const row = await outboundEmailRepository.find(sendId, organizationId);
  if (!row) throw new NotFoundError("Email not found");
  if (row.status !== "UNKNOWN") {
    throw new ConflictError("Only an email whose outcome is unknown can be re-checked");
  }
  const provider = usableProvider();
  // A lookup whose consistency, retention or late-acceptance bound is not declared cannot be believed, so it is not asked.
  if (!provider || !lookupTrusted(provider.sending) || !provider.findSendByKey) {
    throw new ConflictError(
      "The mail provider cannot be asked about this email, so it stays unknown",
    );
  }
  const fresh = await outboundEmailRepository.lastAttemptAt(sendId, organizationId);
  if (tooRecent(fresh, now, resolveGuardMs(provider, deps.sendTimeoutMs))) {
    throw new ConflictError("This was attempted too recently to be sure. Try again later");
  }
  // "Not found" is only evidence while the lookup still remembers: the claim time is an upper bound of the request's age.
  const forgotten =
    fresh === null || now.getTime() - fresh.getTime() > (provider.sending.lookupRetentionMs ?? 0);

  const lookup =
    (await lookupByKey(provider, row.id, deps.sendTimeoutMs ?? OUTBOUND_POLICY.sendTimeoutMs)) ??
    ({ status: "unavailable" } as const);

  const record = async (
    action: "recheck_found" | "recheck_not_found" | "recheck_unavailable",
    newStatus: "SENT" | "FAILED" | "UNKNOWN",
    apply: ((tx: Prisma.TransactionClient) => Promise<boolean>) | null,
  ): Promise<boolean> =>
    transaction(async (tx) => {
      // The state change and its audit row commit together, or neither does.
      if (apply && !(await apply(tx))) return false;
      await outboundEmailAuditRepository.insert(
        {
          organizationId,
          outboundEmailId: sendId,
          action,
          previousStatus: "UNKNOWN",
          newStatus,
          actor: { kind: "user", userId: ctx.user.id },
          reason: null,
        },
        tx,
      );
      return true;
    });

  let outcome: RecheckResult["outcome"];
  if (lookup.status === "found") {
    const applied = await record("recheck_found", "SENT", (tx) =>
      outboundEmailRepository.resolveUnknown(
        sendId,
        organizationId,
        { kind: "provider_lookup_found", providerMessageId: lookup.providerMessageId },
        now,
        tx,
      ),
    );
    if (!applied) throw new ConflictError("This email was resolved by someone else just now");
    await outboundEmailRepository.setThreadProviderId(
      organizationId,
      row.messageId,
      lookup.providerMessageId,
    );
    outcome = "found";
  } else if (lookup.status === "not_found" && forgotten) {
    await record("recheck_unavailable", "UNKNOWN", null);
    outcome = "inconclusive";
  } else if (lookup.status === "not_found") {
    const applied = await record("recheck_not_found", "FAILED", (tx) =>
      outboundEmailRepository.resolveUnknown(
        sendId,
        organizationId,
        { kind: "provider_has_no_record" },
        now,
        tx,
      ),
    );
    if (!applied) throw new ConflictError("This email was resolved by someone else just now");
    outcome = "no_record";
  } else {
    await record("recheck_unavailable", "UNKNOWN", null);
    outcome = "unavailable";
  }
  metrics.increment("email_outbound_total", { result: "unknown_recheck", reason: outcome });
  log.info(
    { organizationId, sendId, actorId: ctx.user.id, outcome },
    "unknown outbound email re-checked",
  );

  const after = await outboundEmailRepository.find(sendId, organizationId);
  return {
    outcome,
    delivery: toDeliveryDto({ ...after!, sentAt: after!.sentAt, failedAt: after!.failedAt }),
  };
}

/**
 * An operator with PRODUCTION access attests that an UNKNOWN email was NOT sent (they checked with the provider). Not
 * reachable over HTTP: the only caller is `scripts/resolve-unknown-email.ts`. Requires an identity and a written reason,
 * records an audit row in the same transaction as the (conditional) transition, and can only ever produce FAILED: there
 * is no operator path to SENT, because that claim needs the provider's evidence (see `recheckUnknown`). It does not
 * resend: a staff member who wants the customer to get it writes a new reply.
 */
export async function resolveUnknownAsOperator(
  input: { organizationId: string; sendId: string; operator: string; reason: string },
  deps: Deps = {},
): Promise<{ resolved: true }> {
  const operator = input.operator.trim();
  const reason = input.reason.trim();
  if (operator.length < 1 || operator.length > 120 || /[\r\n\u0000]/.test(operator)) {
    throw new ValidationError(
      "An operator identity is required (one line, at most 120 characters)",
    );
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new ValidationError("A reason of 10 to 500 characters is required");
  }
  const now = (deps.now ?? (() => new Date()))();

  const row = await outboundEmailRepository.find(input.sendId, input.organizationId);
  if (!row) throw new NotFoundError("Email not found");
  if (row.status !== "UNKNOWN")
    throw new ConflictError("Only an email whose outcome is unknown can be resolved");
  const fresh = await outboundEmailRepository.lastAttemptAt(input.sendId, input.organizationId);
  if (tooRecent(fresh, now, resolveGuardMs(usableProvider(), deps.sendTimeoutMs)))
    throw new ConflictError("This was attempted too recently to be sure. Try again later");

  const applied = await transaction(async (tx) => {
    const done = await outboundEmailRepository.resolveUnknown(
      input.sendId,
      input.organizationId,
      { kind: "operator_confirmed_not_sent" },
      now,
      tx,
    );
    if (!done) return false;
    await outboundEmailAuditRepository.insert(
      {
        organizationId: input.organizationId,
        outboundEmailId: input.sendId,
        action: "operator_confirmed_not_sent",
        previousStatus: "UNKNOWN",
        newStatus: "FAILED",
        actor: { kind: "operator", label: operator },
        reason,
      },
      tx,
    );
    return true;
  });
  if (!applied) throw new ConflictError("This email was resolved by someone else just now");
  metrics.increment("email_outbound_total", { result: "unknown_operator_resolved" });
  log.info(
    { organizationId: input.organizationId, sendId: input.sendId },
    "unknown outbound email resolved by an operator as not sent",
  );
  return { resolved: true };
}
