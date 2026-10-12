import { getDb, type Db } from "@/db/client";

/**
 * Queries for the customer-facing AI (web chat). Everything is scoped by organization AND conversation
 * (and the conversation must be a web chat one); nothing here reads internal notes, metadata or
 * staff data beyond "has a person taken over".
 */
export const customerAiRepository = {
  /** The web chat conversation the AI may answer in, with the minimum state needed to decide. */
  findConversation(organizationId: string, conversationId: string, db: Db = getDb()) {
    return db.conversation.findFirst({
      where: { id: conversationId, organizationId, channel: { in: ["WEB_CHAT", "PORTAL"] } },
      select: {
        id: true,
        channel: true,
        customerId: true,
        status: true,
        visitorSessionId: true,
        humanRequestedAt: true,
        assignedToUserId: true,
        handlingMode: true,
      },
    });
  },

  /** The visitor's message the job is about (must be a customer-facing CUSTOMER message). */
  findCustomerMessage(
    organizationId: string,
    conversationId: string,
    messageId: string,
    db: Db = getDb(),
  ) {
    return db.message.findFirst({
      where: {
        id: messageId,
        organizationId,
        conversationId,
        senderType: "CUSTOMER",
        messageType: "MESSAGE",
      },
      select: { id: true, createdAt: true, body: true },
    });
  },

  /** True when a newer visitor message exists (its own job will answer with the full context). */
  async hasNewerCustomerMessage(
    organizationId: string,
    conversationId: string,
    than: { id: string; createdAt: Date },
    db: Db = getDb(),
  ): Promise<boolean> {
    const newer = await db.message.findFirst({
      where: {
        organizationId,
        conversationId,
        senderType: "CUSTOMER",
        messageType: "MESSAGE",
        OR: [
          { createdAt: { gt: than.createdAt } },
          { createdAt: than.createdAt, id: { gt: than.id } },
        ],
      },
      select: { id: true },
    });
    return newer !== null;
  },

  /**
   * True when the customer-facing message right BEFORE `than` is an AI message that the system flagged
   * as offering a person (`metadata.handoffSuggested`, set by code, never parsed from text). Only then
   * can a plain "yes" be read as accepting that offer.
   */
  async previousMessageOfferedPerson(
    organizationId: string,
    conversationId: string,
    than: { id: string; createdAt: Date },
    db: Db = getDb(),
  ): Promise<boolean> {
    const previous = await db.message.findFirst({
      where: {
        organizationId,
        conversationId,
        messageType: "MESSAGE",
        senderType: { in: ["CUSTOMER", "USER", "AI_AGENT"] },
        OR: [
          { createdAt: { lt: than.createdAt } },
          { createdAt: than.createdAt, id: { lt: than.id } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { senderType: true, metadata: true },
    });
    if (previous?.senderType !== "AI_AGENT") return false;
    const meta = previous.metadata;
    return (
      typeof meta === "object" &&
      meta !== null &&
      !Array.isArray(meta) &&
      (meta as Record<string, unknown>).handoffSuggested === true
    );
  },
};
