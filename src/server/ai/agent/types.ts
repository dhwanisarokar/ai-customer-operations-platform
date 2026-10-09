import type { TokenUsage } from "../types";

/** Only the customer fields the agent needs. Nothing else about the customer reaches the model. */
export type AgentCustomerContext = {
  name: string;
  company: string | null;
  status: string;
};

export type AgentMessage = {
  role: "customer" | "agent" | "ai";
  text: string;
};

export type AgentInput = {
  organizationId: string;
  /**
   * "draft" (default): a suggestion a human reviews (internal Inbox). "customer": the reply is sent to
   * the visitor automatically, so it uses the customer-facing prompt, receives NO customer record
   * (a visitor's identity is unverified) and may only answer from published knowledge.
   */
  mode?: "draft" | "customer";
  customer: AgentCustomerContext;
  /** Bounded, customer-facing history, oldest first. Internal notes are never included. */
  messages: AgentMessage[];
  /** What to search the knowledge base for (derived from the customer's latest messages). */
  retrievalQuery: string;
  /** Data the application fetched with its own tools (already authorized); optional. */
  toolFindings?: string | null;
};

/** A knowledge chunk the answer is based on, with enough metadata for citations and audits. */
export type AgentSource = {
  label: string;
  documentId: string;
  documentTitle: string;
  chunkId: string;
  chunkIndex: number;
  similarity: number;
};

export type AgentResult = {
  reply: string;
  /** True only when the reply is answered from, and cites, retrieved knowledge. */
  grounded: boolean;
  /** True when the reply states facts from the customer's own record (profile / tool results). */
  accountData: boolean;
  /** Sources the model actually cited (validated against what was retrieved). */
  sources: AgentSource[];
  /** Every chunk that was offered to the model, cited or not. */
  retrievedChunkIds: string[];
  promptVersion: string;
  model: string;
  provider: string;
  latencyMs: number;
  usage: TokenUsage;
  /** Why the reply was replaced by the safe fallback, when it was. */
  validation: "ok" | "ungrounded_answer_replaced" | "prompt_leak_replaced";
};
