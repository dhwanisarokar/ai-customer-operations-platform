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
  generateEmbeddings(request: EmbedRequest): Promise<EmbedResult>;
}
