import { getDb, type Db } from "@/db/client";
import type { MessageSenderType, MessageType, Prisma } from "@/generated/prisma/client";

const messageSelect = {
  id: true,
  senderType: true,
  senderUserId: true,
  messageType: true,
  body: true,
  metadata: true,
  createdAt: true,
  sender: { select: { id: true, name: true, email: true } },
} satisfies Prisma.MessageSelect;

type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

/** What clients may learn about how an AI message was produced (no prompts, no usage, no secrets). */
export type AiMessageInfo = {
  provider: string;
  model: string;
  grounded: boolean;
  sources: { documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }[];
};

export type MessageRecord = Omit<MessageRow, "metadata"> & { ai: AiMessageInfo | null };

export type NewMessage = {
  senderType: MessageSenderType;
  senderUserId: string | null;
  messageType: MessageType;
  body: string;
  /** AI messages only: provenance (see src/server/services/ai-reply.ts). */
  metadata?: Prisma.InputJsonValue;
  /** Lets a service stamp the message and the conversation counters with the same instant. */
  createdAt?: Date;
};

/** Defensive projection of stored AI metadata into the public shape; null for non-AI messages. */
export function toAiInfo(senderType: string, metadata: unknown): AiMessageInfo | null {
  if (senderType !== "AI_AGENT" || typeof metadata !== "object" || metadata === null) return null;
  const meta = metadata as Record<string, unknown>;
  const rawSources = Array.isArray(meta.sources) ? meta.sources : [];
  return {
    provider: typeof meta.provider === "string" ? meta.provider : "unknown",
    model: typeof meta.model === "string" ? meta.model : "unknown",
    grounded: meta.grounded === true,
    sources: rawSources.flatMap((source) => {
      const s = source as Record<string, unknown>;
      return typeof s?.documentId === "string" &&
        typeof s.documentTitle === "string" &&
        typeof s.chunkId === "string" &&
        typeof s.chunkIndex === "number"
        ? [
            {
              documentId: s.documentId,
              documentTitle: s.documentTitle,
              chunkId: s.chunkId,
              chunkIndex: s.chunkIndex,
            },
          ]
        : [];
    }),
  };
}

function toRecord({ metadata, ...row }: MessageRow): MessageRecord {
  return { ...row, ai: toAiInfo(row.senderType, metadata) };
}

/**
 * Tenant rule: every function takes `organizationId` and `conversationId`. Customer-facing history
 * is `messageType = MESSAGE`; internal notes are only returned when explicitly requested.
 */
export const conversationMessagesRepository = {
  /** The composite foreign key rejects a conversation that belongs to another organization. */
  async create(
    organizationId: string,
    conversationId: string,
    data: NewMessage,
    db: Db = getDb(),
  ): Promise<MessageRecord> {
    const row = await db.message.create({
      data: { ...data, organizationId, conversationId },
      select: messageSelect,
    });
    return toRecord(row);
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
    return { items: rows.slice(0, options.limit).reverse().map(toRecord), hasMore, total };
  },
};
