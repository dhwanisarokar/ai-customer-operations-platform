import { getDb, type Db } from "@/db/client";
import type { ActivityActorType, ConversationEventType, Prisma } from "@/generated/prisma/client";

const eventSelect = {
  id: true,
  type: true,
  metadata: true,
  actorType: true,
  actorId: true,
  createdAt: true,
} satisfies Prisma.ConversationEventSelect;

export type ConversationEventRecord = Prisma.ConversationEventGetPayload<{
  select: typeof eventSelect;
}>;

export type NewConversationEvent = {
  type: ConversationEventType;
  metadata?: Prisma.InputJsonValue;
  actorType: ActivityActorType;
  actorId: string | null;
  createdAt?: Date;
};

export const conversationEventsRepository = {
  /** Call with the same transaction client as the change it records. */
  record(
    organizationId: string,
    conversationId: string,
    event: NewConversationEvent,
    db: Db = getDb(),
  ): Promise<ConversationEventRecord> {
    return db.conversationEvent.create({
      data: {
        organizationId,
        conversationId,
        type: event.type,
        actorType: event.actorType,
        actorId: event.actorId,
        ...(event.createdAt ? { createdAt: event.createdAt } : {}),
        ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      },
      select: eventSelect,
    });
  },

  /** Records the same event for several conversations in one statement. */
  async recordMany(
    organizationId: string,
    conversationIds: string[],
    event: NewConversationEvent,
    db: Db = getDb(),
  ): Promise<void> {
    if (conversationIds.length === 0) return;
    await db.conversationEvent.createMany({
      data: conversationIds.map((conversationId) => ({
        organizationId,
        conversationId,
        type: event.type,
        actorType: event.actorType,
        actorId: event.actorId,
        ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
      })),
    });
  },

  /** Oldest first. `since` limits the window (used to line events up with loaded messages). */
  async list(
    organizationId: string,
    conversationId: string,
    options: { since?: Date; take: number },
    db: Db = getDb(),
  ): Promise<ConversationEventRecord[]> {
    return db.conversationEvent.findMany({
      where: {
        organizationId,
        conversationId,
        ...(options.since ? { createdAt: { gte: options.since } } : {}),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: options.take,
      select: eventSelect,
    });
  },

  async page(
    organizationId: string,
    conversationId: string,
    page: { skip: number; take: number },
    db: Db = getDb(),
  ): Promise<{ items: ConversationEventRecord[]; total: number }> {
    const where = { organizationId, conversationId };
    const [items, total] = await Promise.all([
      db.conversationEvent.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: page.skip,
        take: page.take,
        select: eventSelect,
      }),
      db.conversationEvent.count({ where }),
    ]);
    return { items, total };
  },
};
