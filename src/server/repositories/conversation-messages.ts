import { getDb, type Db } from "@/db/client";
import type { MessageSenderType, MessageType, Prisma } from "@/generated/prisma/client";

const messageSelect = {
  id: true,
  senderType: true,
  senderUserId: true,
  messageType: true,
  body: true,
  createdAt: true,
  sender: { select: { id: true, name: true, email: true } },
} satisfies Prisma.MessageSelect;

export type MessageRecord = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

export type NewMessage = {
  senderType: MessageSenderType;
  senderUserId: string | null;
  messageType: MessageType;
  body: string;
  /** Lets a service stamp the message and the conversation counters with the same instant. */
  createdAt?: Date;
};

/**
 * Tenant rule: every function takes `organizationId` and `conversationId`. Customer-facing history
 * is `messageType = MESSAGE`; internal notes are only returned when explicitly requested.
 */
export const conversationMessagesRepository = {
  /** The composite foreign key rejects a conversation that belongs to another organization. */
  create(
    organizationId: string,
    conversationId: string,
    data: NewMessage,
    db: Db = getDb(),
  ): Promise<MessageRecord> {
    return db.message.create({
      data: { ...data, organizationId, conversationId },
      select: messageSelect,
    });
  },

  /** True when `messageId` exists in this conversation (validates pagination cursors). */
  async exists(
    organizationId: string,
    conversationId: string,
    messageId: string,
    db: Db = getDb(),
  ): Promise<boolean> {
    const row = await db.message.findFirst({
      where: { id: messageId, organizationId, conversationId },
      select: { id: true },
    });
    return row !== null;
  },

  /**
   * The newest `limit` messages strictly older than the `before` cursor, returned oldest-first
   * (chronological). `hasMore` says whether older messages remain. The cursor must have been
   * validated with `exists` first.
   */
  async page(
    organizationId: string,
    conversationId: string,
    options: { limit: number; before?: string; includeInternal: boolean },
    db: Db = getDb(),
  ): Promise<{ items: MessageRecord[]; hasMore: boolean; total: number }> {
    const where: Prisma.MessageWhereInput = {
      organizationId,
      conversationId,
      ...(options.includeInternal ? {} : { messageType: "MESSAGE" }),
    };
    const [rows, total] = await Promise.all([
      db.message.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: options.limit + 1,
        ...(options.before ? { cursor: { id: options.before }, skip: 1 } : {}),
        select: messageSelect,
      }),
      db.message.count({ where }),
    ]);
    const hasMore = rows.length > options.limit;
    return { items: rows.slice(0, options.limit).reverse(), hasMore, total };
  },
};
