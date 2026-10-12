import { getDb, type Db } from "@/db/client";

/**
 * Conversation queries for the CUSTOMER PORTAL boundary. Every function takes the organization id AND the
 * customer id and puts both in the WHERE clause (and only PORTAL conversations qualify): a conversation id
 * alone never matches, so another customer's (or another organization's) conversation is "not found".
 * Selects are explicit and minimal: no internal notes, metadata, assignees or staff emails.
 */
export type PortalConversationSummary = {
  id: string;
  subject: string;
  status: "OPEN" | "PENDING" | "RESOLVED";
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  lastMessageSenderType: "CUSTOMER" | "USER" | "SYSTEM" | "AI_AGENT" | null;
  humanRequestedAt: Date | null;
  handlingMode: "AI" | "HUMAN";
  assignedToUserId: string | null;
  createdAt: Date;
};

const summarySelect = {
  id: true,
  subject: true,
  status: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  lastMessageSenderType: true,
  humanRequestedAt: true,
  handlingMode: true,
  assignedToUserId: true,
  createdAt: true,
} as const;

const scope = (organizationId: string, customerId: string) =>
  ({ organizationId, customerId, channel: "PORTAL" }) as const;

export const portalConversationsRepository = {
  async list(
    organizationId: string,
    customerId: string,
    page: { page: number; pageSize: number },
    db: Db = getDb(),
  ): Promise<{ items: PortalConversationSummary[]; total: number }> {
    const where = scope(organizationId, customerId);
    const [items, total] = await Promise.all([
      db.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
        select: summarySelect,
      }),
      db.conversation.count({ where }),
    ]);
    return { items, total };
  },

  /** Counts for the portal home. */
  async counts(organizationId: string, customerId: string, db: Db = getDb()) {
    const where = scope(organizationId, customerId);
    const [total, open] = await Promise.all([
      db.conversation.count({ where }),
      db.conversation.count({ where: { ...where, status: { not: "RESOLVED" } } }),
    ]);
    return { total, open };
  },

  /** The conversation only if THIS customer owns it (in THIS organization). */
  findOwned(
    organizationId: string,
    customerId: string,
    id: string,
    db: Db = getDb(),
  ): Promise<PortalConversationSummary | null> {
    return db.conversation.findFirst({
      where: { ...scope(organizationId, customerId), id },
      select: summarySelect,
    });
  },

  countForCustomer(organizationId: string, customerId: string, db: Db = getDb()) {
    return db.conversation.count({ where: scope(organizationId, customerId) });
  },

  /** A conversation of this customer started by the message with this client id (idempotent create). */
  async findByClientMessage(
    organizationId: string,
    customerId: string,
    clientMessageId: string,
    db: Db = getDb(),
  ): Promise<string | null> {
    const row = await db.message.findFirst({
      where: { organizationId, clientMessageId, conversation: scope(organizationId, customerId) },
      select: { conversationId: true },
    });
    return row?.conversationId ?? null;
  },
};
