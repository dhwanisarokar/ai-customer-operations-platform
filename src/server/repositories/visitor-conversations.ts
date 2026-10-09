import { getDb, type Db } from "@/db/client";

/**
 * Conversation queries for the WEB CHAT VISITOR boundary. Every function takes the visitor session
 * id AND the organization id and puts both in the WHERE clause: a conversation id alone never
 * matches, so another visitor's (or another organization's) conversation is simply "not found".
 * Selects are explicit and minimal: no metadata, no internal notes, no staff emails.
 */
export type VisitorConversationSummary = {
  id: string;
  subject: string;
  status: "OPEN" | "PENDING" | "RESOLVED";
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  humanRequestedAt: Date | null;
  /** Used server-side to decide who is answering; never sent to the visitor. */
  assignedToUserId: string | null;
  handlingMode: "AI" | "HUMAN";
  lastMessageSenderType: "CUSTOMER" | "USER" | "SYSTEM" | "AI_AGENT" | null;
  createdAt: Date;
};

const summarySelect = {
  id: true,
  subject: true,
  status: true,
  lastMessageAt: true,
  lastMessagePreview: true,
  humanRequestedAt: true,
  assignedToUserId: true,
  handlingMode: true,
  lastMessageSenderType: true,
  createdAt: true,
} as const;

export type VisitorMessageRow = {
  id: string;
  senderType: "CUSTOMER" | "USER" | "SYSTEM" | "AI_AGENT";
  body: string;
  createdAt: Date;
  clientMessageId: string | null;
  /** Raw metadata of AI messages. The service reads ONE flag from it; it is never returned as is. */
  metadata: unknown;
  sender: { name: string | null } | null;
};

export const visitorConversationsRepository = {
  listForSession(
    organizationId: string,
    visitorSessionId: string,
    take: number,
    db: Db = getDb(),
  ): Promise<VisitorConversationSummary[]> {
    return db.conversation.findMany({
      where: { organizationId, visitorSessionId },
      orderBy: [{ lastMessageAt: "desc" }, { id: "asc" }],
      take,
      select: summarySelect,
    });
  },

  countForSession(organizationId: string, visitorSessionId: string, db: Db = getDb()) {
    return db.conversation.count({ where: { organizationId, visitorSessionId } });
  },

  /** The conversation only if THIS session owns it (in THIS organization). */
  findOwned(
    organizationId: string,
    visitorSessionId: string,
    id: string,
    db: Db = getDb(),
  ): Promise<VisitorConversationSummary | null> {
    return db.conversation.findFirst({
      where: { id, organizationId, visitorSessionId },
      select: summarySelect,
    });
  },

  /** Customer-facing messages only: visitor, team and the web chat AI (never notes or system rows), oldest first. */
  async messages(
    organizationId: string,
    conversationId: string,
    limit: number,
    db: Db = getDb(),
  ): Promise<VisitorMessageRow[]> {
    const rows = await db.message.findMany({
      where: {
        organizationId,
        conversationId,
        messageType: "MESSAGE",
        senderType: { in: ["CUSTOMER", "USER", "AI_AGENT"] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
      select: {
        id: true,
        senderType: true,
        body: true,
        createdAt: true,
        clientMessageId: true,
        metadata: true,
        sender: { select: { name: true } },
      },
    });
    return rows.reverse();
  },

  /** Re-points this session's conversations at another customer (identity resolution). */
  async moveToCustomer(
    organizationId: string,
    visitorSessionId: string,
    customerId: string,
    db: Db = getDb(),
  ) {
    const result = await db.conversation.updateMany({
      where: { organizationId, visitorSessionId },
      data: { customerId, updatedAt: new Date() },
    });
    return result.count;
  },

  /**
   * The visitor asked for a person: sets the handoff marker once AND switches the conversation to
   * HUMAN handling. Two conditional updates, each atomic: `marked` = this call set the marker (false =
   * already requested), `modeChanged` = this call moved AI -> HUMAN (false = it was HUMAN already).
   */
  async requestPerson(
    organizationId: string,
    visitorSessionId: string,
    id: string,
    at: Date,
    db: Db = getDb(),
  ): Promise<{ marked: boolean; modeChanged: boolean }> {
    const scope = { id, organizationId, visitorSessionId };
    const mode = await db.conversation.updateMany({
      where: { ...scope, handlingMode: "AI" },
      data: { handlingMode: "HUMAN", updatedAt: at },
    });
    const marker = await db.conversation.updateMany({
      where: { ...scope, humanRequestedAt: null },
      data: { humanRequestedAt: at, updatedAt: at },
    });
    return { marked: marker.count === 1, modeChanged: mode.count === 1 };
  },
};
