/**
 * How the AI agent should handle a customer message. This is a handling decision only: it is NOT
 * an authorization layer and never grants access to anything.
 */
export type ConversationIntent = "CONVERSATIONAL" | "SUPPORT" | "OUT_OF_SCOPE" | "PROMPT_INJECTION";

export const POLICY_VERSION = "CONVERSATION_POLICY_V1";
