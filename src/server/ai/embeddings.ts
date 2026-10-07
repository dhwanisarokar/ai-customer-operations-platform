import { createLogger } from "@/lib/logger";
import { getAiProvider } from "./client";
import { AI_TIMEOUTS, EMBEDDING_DIMENSIONS } from "./config";
import { AiEmbeddingError } from "./errors";

const log = createLogger("ai.embeddings");

/** Scales a vector to unit length so cosine similarity equals the dot product. */
export function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new AiEmbeddingError("zero_or_invalid_vector");
  return vector.map((value) => value / norm);
}

/** Rejects anything that must never reach the database: wrong size, NaN/Infinity, empty. */
export function validateEmbedding(vector: unknown): number[] {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
    throw new AiEmbeddingError(
      `expected ${EMBEDDING_DIMENSIONS} dimensions, got ${Array.isArray(vector) ? vector.length : "none"}`,
    );
  }
  if (!vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new AiEmbeddingError("non_finite_values");
  }
  return normalizeVector(vector as number[]);
}

/** Embeds document chunks (one vector per text, same order). Titles help models that use them. */
export async function embedDocuments(texts: string[], titles?: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const result = await getAiProvider().generateEmbeddings({
    texts,
    titles,
    purpose: "document",
    timeoutMs: AI_TIMEOUTS.embeddingMs,
  });
  if (result.embeddings.length !== texts.length) {
    throw new AiEmbeddingError("embedding_count_mismatch");
  }
  log.info(
    { count: texts.length, model: result.model, latencyMs: result.latencyMs },
    "embedded documents",
  );
  return result.embeddings.map(validateEmbedding);
}

export async function embedQuery(text: string): Promise<number[]> {
  const result = await getAiProvider().generateEmbeddings({
    texts: [text],
    purpose: "query",
    timeoutMs: AI_TIMEOUTS.embeddingMs,
  });
  if (result.embeddings.length !== 1) throw new AiEmbeddingError("embedding_count_mismatch");
  return validateEmbedding(result.embeddings[0]);
}
