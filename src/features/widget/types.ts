import type { VisitorConversationDto, VisitorMessageDto } from "@/server/widget/visitor";

export type ConversationsResponse = { conversations: VisitorConversationDto[] };
export type ConversationResponse = {
  conversation: VisitorConversationDto;
  messages: VisitorMessageDto[];
};
export type SendInput = { body: string; clientMessageId: string };

/** The three screens inside the open widget. (CLOSED is the launcher on the host page.) */
export type WidgetView =
  | { name: "WELCOME" }
  | { name: "NEW_CONVERSATION" }
  | { name: "ACTIVE_CONVERSATION"; conversationId: string };

export const widgetQueryKeys = {
  all: ["widget"] as const,
  conversations: ["widget", "conversations"] as const,
  conversation: (id: string) => ["widget", "conversation", id] as const,
};

/** How long the "assistant is thinking" indicator may show before we offer a person instead. */
export const ASSISTANT_PATIENCE_MS = 45_000;

/** Which screen to show first, from the visitor's existing conversations. */
export function initialView(conversations: ConversationsResponse["conversations"]): WidgetView {
  const active = conversations.find((c) => c.status !== "RESOLVED");
  if (active) return { name: "ACTIVE_CONVERSATION", conversationId: active.id };
  return conversations.length > 0 ? { name: "WELCOME" } : { name: "NEW_CONVERSATION" };
}
