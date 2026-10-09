import { randomUUID } from "node:crypto";

/**
 * Realtime events are small HINTS, not data: they say "something changed in this conversation" and
 * the client refetches from the database-backed API, which applies authorization again. A lost event
 * therefore never loses data, and an event never carries message text, names or internal metadata.
 */
export const REALTIME_EVENT_TYPES = [
  "message.created",
  "conversation.created",
  "conversation.updated",
  "conversation.assigned",
  "conversation.status_changed",
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENT_TYPES)[number];

export type RealtimeEvent = {
  id: string;
  type: RealtimeEventType;
  conversationId: string;
  /** Only for message.created; the message itself is fetched through the API. */
  messageId?: string;
  at: string;
};

export function buildRealtimeEvent(
  type: RealtimeEventType,
  conversationId: string,
  messageId?: string,
): RealtimeEvent {
  return {
    id: randomUUID(),
    type,
    conversationId,
    ...(messageId ? { messageId } : {}),
    at: new Date().toISOString(),
  };
}
