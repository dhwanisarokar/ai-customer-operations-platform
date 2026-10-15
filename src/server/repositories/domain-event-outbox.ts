import { getDb, type Db } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Tenant rule: events are written with their organization (a foreign key) and read back by id. The
 * reconciler works across organizations by design (it is a system job), but it never mixes them: each row is
 * published with its own organization id.
 */

export type OutboxRow = {
  id: string;
  organizationId: string;
  type: string;
  actorUserId: string | null;
  data: unknown;
  causedByAutomation: boolean;
  occurredAt: Date;
  attempts: number;
};

const select = {
  id: true,
  organizationId: true,
  type: true,
  actorUserId: true,
  data: true,
  causedByAutomation: true,
  occurredAt: true,
  attempts: true,
} as const;

export const domainEventOutboxRepository = {
  /** Always called with the transaction of the change the event describes. */
  insert(
    row: {
      id: string;
      organizationId: string;
      type: string;
      actorUserId: string | null;
      data: Prisma.InputJsonValue;
      causedByAutomation: boolean;
      occurredAt: Date;
      leaseUntil: Date;
    },
    db: Db = getDb(),
  ) {
    return db.domainEventOutbox.create({ data: row, select: { id: true } });
  },

  async markPublished(id: string, now: Date, db: Db = getDb()): Promise<void> {
    await db.domainEventOutbox.updateMany({
      where: { id, publishedAt: null },
      data: { publishedAt: now, lastError: null },
    });
  },

  async markFailed(id: string, code: string, retryAt: Date, db: Db = getDb()): Promise<void> {
    await db.domainEventOutbox.updateMany({
      where: { id, publishedAt: null },
      data: { attempts: { increment: 1 }, lastError: code, leaseUntil: retryAt },
    });
  },

  /**
   * Takes up to `limit` due, unpublished events by moving their lease forward. The conditional update is the
   * claim: of several reconcilers that see the same row, exactly one changes it.
   */
  async claimDue(
    limit: number,
    now: Date,
    leaseUntil: Date,
    db: Db = getDb(),
  ): Promise<OutboxRow[]> {
    const due = await db.domainEventOutbox.findMany({
      where: { publishedAt: null, leaseUntil: { lte: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: limit,
      select,
    });
    const claimed: OutboxRow[] = [];
    for (const row of due) {
      const taken = await db.domainEventOutbox.updateMany({
        where: { id: row.id, publishedAt: null, leaseUntil: { lte: now } },
        data: { leaseUntil },
      });
      if (taken.count === 1) claimed.push(row);
    }
    return claimed;
  },

  /** The text of a message, for events whose consumers need it (it is never copied into the outbox). */
  async messageBody(organizationId: string, messageId: string, db: Db = getDb()) {
    const row = await db.message.findFirst({
      where: { id: messageId, organizationId },
      select: { body: true },
    });
    return row?.body ?? null;
  },

  async deletePublishedBefore(before: Date, db: Db = getDb()): Promise<number> {
    const result = await db.domainEventOutbox.deleteMany({
      where: { publishedAt: { not: null, lt: before } },
    });
    return result.count;
  },

  /** For the maintenance gauges: how many are waiting, how old is the oldest, the worst attempt count. */
  async stats(now: Date, db: Db = getDb()) {
    const [backlog, oldest, worst] = await Promise.all([
      db.domainEventOutbox.count({ where: { publishedAt: null } }),
      db.domainEventOutbox.findFirst({
        where: { publishedAt: null },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true },
      }),
      db.domainEventOutbox.aggregate({
        where: { publishedAt: null },
        _max: { attempts: true },
      }),
    ]);
    return {
      backlog,
      oldestAgeSeconds: oldest
        ? Math.max(0, Math.floor((now.getTime() - oldest.createdAt.getTime()) / 1000))
        : 0,
      maxAttempts: worst._max.attempts ?? 0,
    };
  },
};
