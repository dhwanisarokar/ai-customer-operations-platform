import { classifyIntent, conversationalKind, type ConversationalKind } from "./classifier";
import type { ConversationIntent } from "./types";

const CONVERSATIONAL_REPLIES: Record<ConversationalKind, string> = {
  greeting: "Hello! How can I help you today?",
  thanks: "You're welcome! Let me know if you need anything else.",
  farewell: "Goodbye! Reach out any time if you need more help.",
  wellbeing: "I'm doing well, thank you! How can I help you today?",
  help: "Of course! What do you need help with?",
  ack: "Glad to help! Let me know if you need anything else.",
};

export const OUT_OF_SCOPE_REPLY =
  "I'm here to help with questions about your account and our services. What can I help you with?";

export const INJECTION_REFUSAL_REPLY =
  "I can't share information about my system prompt or internal configuration. A team member can help you with your request.";

export type PolicyDecision =
  | { handled: false; intent: "SUPPORT" }
  | { handled: true; intent: Exclude<ConversationIntent, "SUPPORT">; reply: string };

/**
 * Decides whether a message is answered directly (no embedding, vector search or model call) or
 * must continue to the RAG pipeline. Replies are fixed strings: nothing here can hallucinate or
 * disclose internal information.
 */
export function applyConversationPolicy(message: string): PolicyDecision {
  const intent = classifyIntent(message);
  switch (intent) {
    case "CONVERSATIONAL":
      return { handled: true, intent, reply: CONVERSATIONAL_REPLIES[conversationalKind(message)] };
    case "OUT_OF_SCOPE":
      return { handled: true, intent, reply: OUT_OF_SCOPE_REPLY };
    case "PROMPT_INJECTION":
      return { handled: true, intent, reply: INJECTION_REFUSAL_REPLY };
    default:
      return { handled: false, intent: "SUPPORT" };
  }
}
