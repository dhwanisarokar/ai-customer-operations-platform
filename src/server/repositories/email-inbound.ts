import { getDb, type Db } from "@/db/client";
import type {
  EmailDirection,
  EmailEventOutcome,
  EmailHoldReason,
  Prisma,
} from "@/generated/prisma/client";

/**
 * Tenant rule for this file: everything that touches an organization's email data takes `organizationId`
 * and puts it in the WHERE clause. The two exceptions are deliberate and global by nature: resolving a
 * recipient address to its organization (the address is globally unique) and the replay ledger (it holds
 * no content and no addresses).
 */

type EmailRecord = {
  organizationId: string;
  conversationId: string;
  messageId: string;
  direction: EmailDirection;
  providerMessageId: string | null;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  spf: string;
  dkim: string;
  authDetail?: Prisma.InputJsonValue;
  attachments: Prisma.InputJsonValue;
  receivedAt: Date;
};

type HeldRecord = {
  organizationId: string;
  reason: EmailHoldReason;
  providerMessageId: string;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  references: string[];
  fromAddress: string;
  fromName: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string;
  body: string;
  authDetail?: Prisma.InputJsonValue;
  spf: string;
  dkim: string;
  attachments: Prisma.InputJsonValue;
  receivedAt: Date;
};

export const emailInboundRepository = {
  /**
   * The organizations whose ENABLED, verified support address is one of `addresses`. This is the only way
   * an inbound email is routed: the recipient is looked up in trusted configuration.
   */
  async findDeliveryTargets(addresses: string[], db: Db = getDb()) {
    if (addresses.length === 0) return [];
    return db.emailSettings.findMany({
      where: { supportAddress: { in: addresses }, enabled: true, status: "ACTIVE" },
      select: { organizationId: true, supportAddress: true },
      orderBy: { supportAddress: "asc" },
    });
  },

  async hasWebhookEvent(replayKey: string, db: Db = getDb()): Promise<boolean> {
    return (await db.emailWebhookEvent.count({ where: { replayKey } })) > 0;
  },

  /** Remembers a consumed notification. False when it had already been recorded (a concurrent replay). */
  async recordWebhookEvent(
    replayKey: string,
    outcome: EmailEventOutcome,
    reason: string | null,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.emailWebhookEvent.createMany({
      data: [{ replayKey, outcome, reason }],
      skipDuplicates: true,
    });
    return result.count === 1;
  },

  /** Retention: removes ledger entries created before `before`. Returns how many were removed. */
  async deleteWebhookEventsBefore(before: Date, db: Db = getDb()): Promise<number> {
    const result = await db.emailWebhookEvent.deleteMany({ where: { createdAt: { lt: before } } });
    return result.count;
  },

  /** The conversations, inside this organization, that already contain one of these RFC Message-IDs. */
  findConversationsByRfcIds(organizationId: string, rfcIds: string[], db: Db = getDb()) {
    if (rfcIds.length === 0) return Promise.resolve([]);
    return db.emailMessage.findMany({
      where: { organizationId, rfcMessageId: { in: rfcIds } },
      select: { rfcMessageId: true, conversationId: true },
    });
  },

  /** Was this provider message already ingested (stored or held) for this organization? */
  async isKnown(organizationId: string, providerMessageId: string, db: Db = getDb()) {
    const [stored, held] = await Promise.all([
      db.emailMessage.count({ where: { organizationId, providerMessageId } }),
      db.emailHeldMessage.count({ where: { organizationId, providerMessageId } }),
    ]);
    return stored + held > 0;
  },

  createEmailMessage(data: EmailRecord, db: Db = getDb()) {
    return db.emailMessage.create({ data, select: { id: true } });
  },

  createHeld(data: HeldRecord, db: Db = getDb()) {
    return db.emailHeldMessage.create({ data, select: { id: true } });
  },

  countOpenHeld(organizationId: string, reason?: EmailHoldReason, db: Db = getDb()) {
    return db.emailHeldMessage.count({
      where: { organizationId, resolvedAt: null, ...(reason ? { reason } : {}) },
    });
  },

  /** For the maintenance gauges: open held mail per organization and reason (counts only, no content). */
  async openHeldByOrganization(db: Db = getDb()) {
    return db.emailHeldMessage.groupBy({
      by: ["organizationId", "reason"],
      where: { resolvedAt: null },
      _count: { _all: true },
    });
  },

  /** Ledger entries ignored since `since`, by coded reason (operational visibility into dropped mail). */
  async ignoredReasonsSince(since: Date, db: Db = getDb()) {
    return db.emailWebhookEvent.groupBy({
      by: ["reason"],
      where: { outcome: "IGNORED", createdAt: { gte: since } },
      _count: { _all: true },
    });
  },

  countWebhookEvents(db: Db = getDb()) {
    return db.emailWebhookEvent.count();
  },

  /**
   * Inbound emails this organization received since `since`: the volume quota. Held mail whose reason is an
   * UNAUTHENTICATED sender is NOT counted: that kind is the cheapest to forge in bulk, and counting it would let
   * anyone use up the organization's quota with spoofed mail and lock legitimate customers out. It is bounded
   * separately (the per-reason held cap and the per-sender cap).
   */
  async countReceivedSince(organizationId: string, since: Date, db: Db = getDb()) {
    const [stored, held] = await Promise.all([
      db.emailMessage.count({
        where: { organizationId, direction: "INBOUND", createdAt: { gte: since } },
      }),
      db.emailHeldMessage.count({
        where: {
          organizationId,
          createdAt: { gte: since },
          reason: { not: "UNAUTHENTICATED_SENDER" },
        },
      }),
    ]);
    return stored + held;
  },

  /** Retention: removes UNRESOLVED held mail created before `before`. Returns how many were removed. */
  async deleteUnresolvedHeldBefore(before: Date, db: Db = getDb()): Promise<number> {
    const result = await db.emailHeldMessage.deleteMany({
      where: { resolvedAt: null, createdAt: { lt: before } },
    });
    return result.count;
  },

  /** The same, for one sender address: the per-sender spam bound. */
  async countFromSenderSince(
    organizationId: string,
    fromAddress: string,
    since: Date,
    db: Db = getDb(),
  ) {
    const [stored, held] = await Promise.all([
      db.emailMessage.count({
        where: { organizationId, direction: "INBOUND", fromAddress, createdAt: { gte: since } },
      }),
      db.emailHeldMessage.count({
        where: { organizationId, fromAddress, createdAt: { gte: since } },
      }),
    ]);
    return stored + held;
  },
};
