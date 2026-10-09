import { createLogger } from "@/lib/logger";
import type { DomainEvent } from "@/server/events/types";
import { conversationsRepository } from "@/server/repositories/conversations";
import { buildRealtimeEvent, type RealtimeEventType } from "./events";
import { inboxChannel, visitorChannel } from "./channels";
import { publishRealtime } from "./publisher";

const log = createLogger("realtime");

/**
 * Bridges committed DOMAIN events to realtime hints:
 *
 *   inbox channel (staff of the organization): every change to a conversation
 *   visitor channel (the owning web chat visitor): customer-facing messages, status, assignment
 *
 * Internal notes never reach a visitor channel. Called after the database transaction committed;
 * it never throws and never delays the caller (a failure only means a client refetches later).
 */
export async function publishForDomainEvent(event: DomainEvent): Promise<void> {
  try {
    const data = event.data as Record<string, unknown>;
    const conversationId = typeof data.conversationId === "string" ? data.conversationId : null;
    if (!conversationId) return;

    let type: RealtimeEventType | null = null;
    let toVisitor = false;
    let messageId: string | undefined;

    switch (event.type) {
      case "message.created":
        type = "message.created";
        messageId = typeof data.messageId === "string" ? data.messageId : undefined;
        // Only customer-facing messages (visitor, team, the web chat AI) are shown to a visitor.
        toVisitor =
          data.messageType === "MESSAGE" &&
          (data.senderType === "CUSTOMER" ||
            data.senderType === "USER" ||
            data.senderType === "AI_AGENT");
        break;
      case "conversation.created":
        type = "conversation.created";
        break;
      case "conversation.status_changed":
        type = "conversation.status_changed";
        toVisitor = true;
        break;
      case "conversation.assigned":
        type = "conversation.assigned";
        toVisitor = true;
        break;
      case "conversation.priority_changed":
        type = "conversation.updated";
        break;
      default:
        return;
    }

    const realtime = buildRealtimeEvent(type, conversationId, messageId);
    await publishRealtime(inboxChannel(event.organizationId), realtime);

    if (toVisitor) {
      const visitorSessionId = await conversationsRepository.visitorSessionIdOf(
        event.organizationId,
        conversationId,
      );
      if (visitorSessionId) await publishRealtime(visitorChannel(visitorSessionId), realtime);
    }
  } catch (error) {
    log.warn(
      {
        organizationId: event.organizationId,
        eventType: event.type,
        err: error instanceof Error ? error.name : "unknown",
      },
      "realtime bridge failed",
    );
  }
}

/** Handoff and other non-domain conversation changes: a plain "updated" hint to both sides. */
export async function publishConversationUpdated(
  organizationId: string,
  conversationId: string,
  visitorSessionId: string | null,
): Promise<void> {
  const realtime = buildRealtimeEvent("conversation.updated", conversationId);
  await publishRealtime(inboxChannel(organizationId), realtime);
  if (visitorSessionId) await publishRealtime(visitorChannel(visitorSessionId), realtime);
}
