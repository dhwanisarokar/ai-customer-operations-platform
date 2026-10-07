import { getServerEnv } from "@/lib/env";

/**
 * Single source of truth for AI configuration. Application code imports these values; nothing
 * else hard-codes a model name, dimension or retrieval threshold.
 */

/**
 * Stored embedding size. This is a database fact (the vector(768) column), not a tunable:
 * changing it requires a migration and re-embedding every chunk. 768 is a supported
 * (Matryoshka-truncated) size of the Gemini embedding models: roughly 4x smaller than the 3072
 * default (storage, memory, scan time) with a small quality loss that is acceptable for support
 * articles.
 */
export const EMBEDDING_DIMENSIONS = 768;

const DEFAULT_GENERATION_MODEL = "gemini-2.5-flash";
const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-2";

/**
 * Initial relevance threshold (cosine similarity, 0..1). A starting point, NOT an optimum.
 * Measured once with gemini-embedding-2 at 768 dimensions on a small hand-made set (6 support
 * documents x 8 queries): relevant matches scored 0.68-0.81, off-topic queries at most 0.55, and
 * on-topic queries against the wrong document up to 0.65. 0.60 drops off-topic noise while keeping
 * recall for paraphrased questions; the model must still cite what it uses and may decline.
 * Re-measure with real organization data and tune via RAG_MIN_SIMILARITY (see docs/rag.md).
 */
const DEFAULT_MIN_SIMILARITY = 0.6;

export type AiConfig = {
  apiKey: string | undefined;
  generationModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  minSimilarity: number;
};

export function getAiConfig(): AiConfig {
  const env = getServerEnv();
  return {
    apiKey: env.GEMINI_API_KEY,
    generationModel: env.GEMINI_GENERATION_MODEL ?? DEFAULT_GENERATION_MODEL,
    embeddingModel: env.GEMINI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: EMBEDDING_DIMENSIONS,
    minSimilarity: env.RAG_MIN_SIMILARITY ?? DEFAULT_MIN_SIMILARITY,
  };
}

/** Retrieval and context limits for the support agent. */
export const AGENT_LIMITS = {
  /** Most chunks passed to the model. */
  retrievalLimit: 5,
  /** Most recent customer-facing messages included as conversation context. */
  maxContextMessages: 12,
  /** Per-message truncation (characters) in the prompt. */
  maxMessageChars: 1500,
  /** Total conversation context budget (characters, roughly 2k tokens). */
  maxConversationChars: 8000,
  /** Query text sent to the embedding model (characters). */
  maxQueryChars: 1500,
  /** Longest reply accepted from the model (characters). */
  maxReplyChars: 4000,
} as const;

export const AI_TIMEOUTS = {
  generationMs: 30_000,
  embeddingMs: 20_000,
} as const;

/** Whether the AI may request tools (lookups and approval-gated changes) while drafting. */
export function aiToolsEnabled(): boolean {
  return getServerEnv().AI_TOOLS_ENABLED !== "false";
}
