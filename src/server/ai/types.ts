/** Provider-neutral AI contracts. Application services depend on these, never on a vendor SDK. */

export type TokenUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
};

export type GenerateRequest = {
  systemInstruction: string;
  /** The (already sanitized) user-turn content. */
  prompt: string;
  /** When set, the provider must return JSON conforming to this JSON Schema. */
  responseJsonSchema?: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
};

export type GenerateResult = {
  text: string;
  model: string;
  provider: string;
  latencyMs: number;
  finishReason: string | null;
  /** Null fields when the provider did not report usage; never estimated. */
  usage: TokenUsage;
};

/** A function the model may REQUEST. The application decides whether and how it runs. */
export type ToolDeclaration = {
  name: string;
  description: string;
  parametersJsonSchema: Record<string, unknown>;
};

export type ToolCallRequest = { name: string; args: Record<string, unknown> };

/** One turn of a tool-calling exchange (provider-neutral). */
export type ToolTurn =
  | { role: "user"; text: string }
  | {
      role: "model";
      text: string;
      toolCalls: ToolCallRequest[];
      /** Opaque provider content, passed back verbatim on the next call (e.g. thought signatures). */
      providerData?: unknown;
    }
  | { role: "tool"; name: string; response: Record<string, unknown> };

export type ToolGenerateRequest = {
  systemInstruction: string;
  turns: ToolTurn[];
  tools: ToolDeclaration[];
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs: number;
};

export type ToolGenerateResult = {
  /** Text the model produced (may be empty when it only requests tools). */
  text: string;
  toolCalls: ToolCallRequest[];
  providerData?: unknown;
  model: string;
  provider: string;
  latencyMs: number;
  finishReason: string | null;
  usage: TokenUsage;
};

export type EmbeddingPurpose = "document" | "query";

export type EmbedRequest = {
  texts: string[];
  purpose: EmbeddingPurpose;
  /** Optional per-text titles (documents only), used by models that accept a title hint. */
  titles?: string[];
  timeoutMs: number;
};

export type EmbedResult = {
  embeddings: number[][];
  model: string;
  provider: string;
  dimensions: number;
  latencyMs: number;
};

export interface AIProvider {
  readonly name: string;
  generateResponse(request: GenerateRequest): Promise<GenerateResult>;
  /**
   * Generation with function calling. The model may return `toolCalls`; it never executes them.
   * Callers run the requested tools (deterministically authorized) and send the results back.
   */
  generateWithTools(request: ToolGenerateRequest): Promise<ToolGenerateResult>;
  generateEmbeddings(request: EmbedRequest): Promise<EmbedResult>;
}
