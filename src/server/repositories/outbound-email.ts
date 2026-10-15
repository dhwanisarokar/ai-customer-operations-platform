import { getDb, transaction, type Db } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Tenant rule: every function that acts on one send is keyed by `(id, organizationId)`. The two cross-tenant
 * readers (`listDue`, `listExpired`, `stats`) are for the system reconciler and return only ids; the reconciler
 * and the job handler then always continue with the row's own organization.
 *
 * State rule: EVERY state change is one conditional update (`updateMany` with the expected current state, and for
 * PROCESSING the expected attempt number as a fencing token). A caller that lost the race changes nothing and
 * learns it from the returned boolean. There is no read-then-write anywhere in this file.
 */

const select = {
  id: true,
  organizationId: true,
  conversationId: true,
  messageId: true,
  emailSettingsId: true,
  fromAddress: true,
  fromName: true,
  toAddress: true,
  subject: true,
  rfcMessageId: true,
  inReplyTo: true,
  references: true,
  status: true,
  attempts: true,
  retries: true,
  nextAttemptAt: true,
  leaseUntil: true,
  // When the last attempt was CLAIMED (a takeover does not move it): an upper bound of how long ago its request was sent.
  lastAttemptAt: true,
  providerMessageId: true,
  sentAt: true,
  failedAt: true,
  lastErrorCode: true,
  finalReason: true,
} as const;

export type OutboundEmailRow = NonNullable<Awaited<ReturnType<typeof findOne>>>;

function findOne(id: string, organizationId: string, db: Db) {
  return db.outboundEmail.findFirst({ where: { id, organizationId }, select });
}

/** The evidence that justifies leaving UNKNOWN (see `resolveUnknown`). `kind` is also stored as the final reason. */
export type UnknownResolution =
  | { kind: "provider_lookup_found"; providerMessageId: string }
  | { kind: "provider_has_no_record" }
  | { kind: "operator_confirmed_not_sent" };

export type NewOutboundEmail = {
  id: string;
  organizationId: string;
  conversationId: string;
  messageId: string;
  emailSettingsId: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  subject: string;
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
  nextAttemptAt: Date;
};

export const outboundEmailRepository = {
  /** Always called with the transaction that stores the message it delivers. */
  create(data: NewOutboundEmail, db: Db = getDb()) {
    return db.outboundEmail.create({ data, select });
  },

  find(id: string, organizationId: string, db: Db = getDb()) {
    return findOne(id, organizationId, db);
  },

  /**
   * Atomically claims a due PENDING / RETRY_SCHEDULED send: status PROCESSING, attempts + 1, a lease. Exactly one
   * of any number of concurrent callers gets the row; the others get null. The returned `attempts` is the fencing
   * token for finalizing this attempt.
   */
  async claim(id: string, organizationId: string, now: Date, leaseUntil: Date) {
    return transaction(async (tx) => {
      const taken = await tx.outboundEmail.updateMany({
        where: {
          id,
          organizationId,
          status: { in: ["PENDING", "RETRY_SCHEDULED"] },
          nextAttemptAt: { lte: now },
        },
        data: {
          status: "PROCESSING",
          attempts: { increment: 1 },
          leaseUntil,
          lastAttemptAt: now,
          updatedAt: now,
        },
      });
      return taken.count === 1 ? findOne(id, organizationId, tx) : null;
    });
  },

  /**
   * Takes over a PROCESSING send whose lease expired (the worker died or hung). attempts + 1 makes the dead
   * worker's token stale, so if it wakes up later its finalize is refused. The outcome of the dead attempt is
   * UNKNOWN; the caller resolves it with `decideAmbiguous`. No provider call is made by a takeover, so it leaves
   * `lastAttemptAt` (the claim time of the last call-making attempt) alone: the lookup-retention check depends on it.
   */
  async takeOverExpired(id: string, organizationId: string, now: Date, leaseUntil: Date) {
    return transaction(async (tx) => {
      const taken = await tx.outboundEmail.updateMany({
        where: { id, organizationId, status: "PROCESSING", leaseUntil: { lte: now } },
        data: { attempts: { increment: 1 }, leaseUntil, updatedAt: now },
      });
      return taken.count === 1 ? findOne(id, organizationId, tx) : null;
    });
  },

  /**
   * Moves the lease of the CURRENT attempt later (never earlier), fenced by the attempt number like every other write. Used
   * (a) by the claim holder when its lease would leave less than the provider's settle window before a call, and (b) by
   * recovery that must wait for a settle window to end, so that it asks again once, not every lease. It changes no state and
   * increments nothing.
   */
  async extendLease(
    id: string,
    organizationId: string,
    attempt: number,
    leaseUntil: Date,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.outboundEmail.updateMany({
      where: {
        id,
        organizationId,
        status: "PROCESSING",
        attempts: attempt,
        leaseUntil: { lt: leaseUntil },
      },
      data: { leaseUntil, updatedAt: now },
    });
    return result.count === 1;
  },

  // ---- finalizing an attempt: only the holder of the current attempt number may do it --------------------

  async markSent(
    id: string,
    organizationId: string,
    attempt: number,
    providerMessageId: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.outboundEmail.updateMany({
      where: { id, organizationId, status: "PROCESSING", attempts: attempt },
      data: {
        status: "SENT",
        providerMessageId,
        sentAt: now,
        leaseUntil: null,
        lastErrorCode: null,
        updatedAt: now,
      },
    });
    return result.count === 1;
  },

  /**
   * `consumesBudget` is true when the attempt that ended here really called the provider (the retry budget `retries`
   * moves by one). It is false only for "no request was made" (the claim could not start a call), which must not eat the
   * budget meant for real send attempts.
   */
  async scheduleRetry(
    id: string,
    organizationId: string,
    attempt: number,
    code: string,
    nextAttemptAt: Date,
    now: Date,
    db: Db = getDb(),
    consumesBudget = true,
  ): Promise<boolean> {
    const result = await db.outboundEmail.updateMany({
      where: { id, organizationId, status: "PROCESSING", attempts: attempt },
      data: {
        status: "RETRY_SCHEDULED",
        ...(consumesBudget ? { retries: { increment: 1 } } : {}),
        nextAttemptAt,
        leaseUntil: null,
        lastErrorCode: code,
        updatedAt: now,
      },
    });
    return result.count === 1;
  },

  async markFailed(
    id: string,
    organizationId: string,
    attempt: number,
    code: string,
    reason: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.outboundEmail.updateMany({
      where: { id, organizationId, status: "PROCESSING", attempts: attempt },
      data: {
        status: "FAILED",
        failedAt: now,
        finalReason: reason,
        leaseUntil: null,
        lastErrorCode: code,
        updatedAt: now,
      },
    });
    return result.count === 1;
  },

  async markUnknown(
    id: string,
    organizationId: string,
    attempt: number,
    code: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.outboundEmail.updateMany({
      where: { id, organizationId, status: "PROCESSING", attempts: attempt },
      data: { status: "UNKNOWN", leaseUntil: null, lastErrorCode: code, updatedAt: now },
    });
    return result.count === 1;
  },

  /**
   * The ONLY exit from UNKNOWN, and it needs EVIDENCE of one of three kinds (a type, so an arbitrary "mark it sent" is
   * not expressible):
   *   - the provider's own lookup FOUND the send (the provider message id comes from the provider);
   *   - the provider's authoritative lookup has NO RECORD of it;
   *   - an operator attested that it was NOT sent (identity and reason are audited by the caller).
   * It is one conditional update on `status = UNKNOWN`: it cannot touch any other state, and a worker (which only
   * finalizes PROCESSING attempts) can never overwrite a resolved send. The caller writes the audit row in the same
   * transaction (`outbound-ops.ts`); nothing else should call this.
   */
  async resolveUnknown(
    id: string,
    organizationId: string,
    evidence: UnknownResolution,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.outboundEmail.updateMany({
      where: { id, organizationId, status: "UNKNOWN" },
      data:
        evidence.kind === "provider_lookup_found"
          ? {
              status: "SENT",
              providerMessageId: evidence.providerMessageId,
              sentAt: now,
              updatedAt: now,
            }
          : {
              status: "FAILED",
              failedAt: now,
              finalReason: evidence.kind,
              updatedAt: now,
            },
    });
    return result.count === 1;
  },

  /** Records the provider id on the thread index row once known (outbound `email_messages`). */
  async setThreadProviderId(
    organizationId: string,
    messageId: string,
    providerMessageId: string,
    db: Db = getDb(),
  ): Promise<void> {
    await db.emailMessage.updateMany({
      where: { organizationId, messageId, direction: "OUTBOUND", providerMessageId: null },
      data: { providerMessageId },
    });
  },

  // ---- reconciler (system-level, ids only) -------------------------------------------------------------

  /** Sends that are due and not in flight: the wake-up candidates (covers a lost or never-sent queue job). */
  listDue(limit: number, now: Date, db: Db = getDb()) {
    return db.outboundEmail.findMany({
      where: { status: { in: ["PENDING", "RETRY_SCHEDULED"] }, nextAttemptAt: { lte: now } },
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, organizationId: true, attempts: true },
    });
  },

  /** In-flight sends whose lease ran out: a crashed or hung attempt. */
  listExpired(limit: number, now: Date, db: Db = getDb()) {
    return db.outboundEmail.findMany({
      where: { status: "PROCESSING", leaseUntil: { lte: now } },
      orderBy: [{ leaseUntil: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, organizationId: true, attempts: true },
    });
  },

  /**
   * Gauges for monitoring. "Due" work is of two kinds with DIFFERENT clocks: a waiting send is due since its
   * `nextAttemptAt`, an in-flight send whose lease expired is overdue since its `leaseUntil`. The oldest of EACH kind is
   * read with its own ordering and the larger age wins (ordering both by `nextAttemptAt` under-reported: an old attempt
   * with a recent lease expiry hid a send that had been waiting longer).
   *
   * Work that waits BY DESIGN (a scheduled retry whose time has not come) is only counted as `retryWaiting`; it is
   * never "due" and never raises an alert.
   */
  async stats(now: Date, db: Db = getDb()) {
    const waitingDue = {
      status: { in: ["PENDING", "RETRY_SCHEDULED"] as ("PENDING" | "RETRY_SCHEDULED")[] },
      nextAttemptAt: { lte: now },
    };
    const expired = { status: "PROCESSING" as const, leaseUntil: { lte: now } };
    const [
      waitingCount,
      expiredCount,
      oldestWaiting,
      oldestExpired,
      unknown,
      retryWaiting,
      processing,
    ] = await Promise.all([
      db.outboundEmail.count({ where: waitingDue }),
      db.outboundEmail.count({ where: expired }),
      db.outboundEmail.findFirst({
        where: waitingDue,
        orderBy: { nextAttemptAt: "asc" },
        select: { nextAttemptAt: true },
      }),
      db.outboundEmail.findFirst({
        where: expired,
        orderBy: { leaseUntil: "asc" },
        select: { leaseUntil: true },
      }),
      db.outboundEmail.count({ where: { status: "UNKNOWN" } }),
      db.outboundEmail.count({ where: { status: "RETRY_SCHEDULED", nextAttemptAt: { gt: now } } }),
      db.outboundEmail.count({ where: { status: "PROCESSING", leaseUntil: { gt: now } } }),
    ]);
    const ages = [oldestWaiting?.nextAttemptAt, oldestExpired?.leaseUntil]
      .filter((d): d is Date => d instanceof Date)
      .map((d) => Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000)));
    return {
      due: waitingCount + expiredCount,
      oldestDueAgeSeconds: ages.length ? Math.max(...ages) : 0,
      unknown,
      /** In flight with a valid lease: normal work. */
      processing,
      /** Waiting for a scheduled retry whose time has not come: normal, never an alert. */
      retryWaiting,
      /** Lease expired: the worker that held it died or hung. */
      expiredLeases: expiredCount,
    };
  },

  // ---- operational view (organization-scoped, bounded) ------------------------------------------------------

  async attention(
    organizationId: string,
    options: { where: Prisma.OutboundEmailWhereInput; page: number; pageSize: number },
    db: Db = getDb(),
  ) {
    const where = { organizationId, ...options.where };
    const [items, total] = await Promise.all([
      db.outboundEmail.findMany({
        where,
        orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
        skip: (options.page - 1) * options.pageSize,
        take: options.pageSize,
        select: {
          id: true,
          conversationId: true,
          messageId: true,
          status: true,
          attempts: true,
          toAddress: true,
          nextAttemptAt: true,
          leaseUntil: true,
          failedAt: true,
          updatedAt: true,
          finalReason: true,
        },
      }),
      db.outboundEmail.count({ where }),
    ]);
    return { items, total };
  },

  countWhere(organizationId: string, where: Prisma.OutboundEmailWhereInput, db: Db = getDb()) {
    return db.outboundEmail.count({ where: { organizationId, ...where } });
  },

  // ---- what a delivery needs, read at send time (never copied into the send row) -------------------------

  async messageForSend(
    organizationId: string,
    conversationId: string,
    messageId: string,
    db: Db = getDb(),
  ) {
    return db.message.findFirst({
      where: { id: messageId, organizationId, conversationId },
      select: { body: true, senderType: true, messageType: true },
    });
  },

  /** When the last attempt was claimed (organization-scoped). */
  async lastAttemptAt(id: string, organizationId: string, db: Db = getDb()): Promise<Date | null> {
    const row = await db.outboundEmail.findFirst({
      where: { id, organizationId },
      select: { lastAttemptAt: true },
    });
    return row?.lastAttemptAt ?? null;
  },

  /** The send that delivers a message (organization-scoped), if any. */
  findByMessage(organizationId: string, messageId: string, db: Db = getDb()) {
    return db.outboundEmail.findFirst({ where: { organizationId, messageId }, select });
  },

  /**
   * What staff may see of deliveries, for a page of one conversation's messages. Scoped by organization AND
   * conversation, so a message id from anywhere else matches nothing.
   */
  deliveryForMessages(
    organizationId: string,
    conversationId: string,
    messageIds: string[],
    db: Db = getDb(),
  ) {
    if (messageIds.length === 0) return Promise.resolve([]);
    return db.outboundEmail.findMany({
      where: { organizationId, conversationId, messageId: { in: messageIds } },
      select: {
        messageId: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        sentAt: true,
        failedAt: true,
        finalReason: true,
      },
    });
  },

  /** The conversation a reply goes to, with the customer's address (the ONLY source of the recipient). */
  conversationForSend(organizationId: string, conversationId: string, db: Db = getDb()) {
    return db.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: {
        channel: true,
        subject: true,
        customer: { select: { id: true, email: true, status: true } },
      },
    });
  },

  /**
   * The Message-IDs already used in this conversation (inbound AND outbound), newest first, scoped to the
   * organization and the conversation. This is all a reply's threading is derived from: never the subject.
   */
  threadIds(organizationId: string, conversationId: string, limit: number, db: Db = getDb()) {
    return db.emailMessage.findMany({
      where: { organizationId, conversationId, rfcMessageId: { not: null } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { rfcMessageId: true, direction: true },
    });
  },

  async settingsForSend(organizationId: string, emailSettingsId: string, db: Db = getDb()) {
    return db.emailSettings.findFirst({
      where: { id: emailSettingsId, organizationId },
      select: { enabled: true, status: true, supportAddress: true },
    });
  },
};
