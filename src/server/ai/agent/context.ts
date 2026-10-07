import { fullName } from "@/features/customers/normalize";
import { AGENT_LIMITS } from "../config";
import type { AgentCustomerContext, AgentMessage } from "./types";

type StoredMessage = { senderType: string; body: string };

const ROLE_BY_SENDER: Record<string, AgentMessage["role"] | undefined> = {
  CUSTOMER: "customer",
  USER: "agent",
  AI_AGENT: "ai",
};

/** The minimum customer data the model needs. Email, phone, metadata and notes are not included. */
export function toCustomerContext(customer: {
  firstName: string;
  lastName: string | null;
  company: string | null;
  status: string;
}): AgentCustomerContext {
  return { name: fullName(customer), company: customer.company, status: customer.status };
}

/**
 * Turns stored (oldest-first, customer-facing) messages into bounded prompt context: SYSTEM
 * messages are skipped, each message is truncated, and the total character budget is filled from
 * the newest message backwards, so the most recent turns always survive.
 */
export function toConversationContext(messages: StoredMessage[]): AgentMessage[] {
  const usable = messages
    .map((message) => ({ role: ROLE_BY_SENDER[message.senderType], text: message.body.trim() }))
    .filter((message): message is AgentMessage => message.role !== undefined && message.text !== "")
    .slice(-AGENT_LIMITS.maxContextMessages);

  const kept: AgentMessage[] = [];
  let budget = AGENT_LIMITS.maxConversationChars;
  for (let i = usable.length - 1; i >= 0 && budget > 0; i--) {
    const text = usable[i].text.slice(0, Math.min(AGENT_LIMITS.maxMessageChars, budget));
    kept.unshift({ role: usable[i].role, text });
    budget -= text.length;
  }
  return kept;
}

/**
 * What to search the knowledge base for: the customer's latest message, plus the one before it
 * when the latest is very short ("and for annual plans?") so the query still carries the topic.
 */
export function buildRetrievalQuery(messages: AgentMessage[]): string | null {
  const customerTexts = messages.filter((m) => m.role === "customer").map((m) => m.text);
  if (customerTexts.length === 0) return null;
  const latest = customerTexts[customerTexts.length - 1];
  const previous = customerTexts.length > 1 ? customerTexts[customerTexts.length - 2] : null;
  const query = latest.length < 40 && previous ? `${previous}\n${latest}` : latest;
  return query.slice(0, AGENT_LIMITS.maxQueryChars);
}
