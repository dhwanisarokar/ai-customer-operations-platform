import type { GoogleGenAI } from "@google/genai";
import { createLogger } from "@/lib/logger";
import { AiEmbeddingError, AiProviderError, AiTimeoutError } from "../errors";
import type { EmbedRequest, EmbedResult, EmbeddingPurpose } from "../types";
import { describeError } from "./generation";

const log = createLogger("ai.gemini");

/** Gemini accepts up to 100 inputs per embedContent request; stay well below it. */
const BATCH_SIZE = 50;

/**
 * Older embedding models (gemini-embedding-001, text-embedding-*) take a taskType parameter.
 * Newer ones are steered by a short text prefix instead, so the purpose is applied to the text.
 */
function supportsTaskType(model: string): boolean {
  return /embedding-001|text-embedding/.test(model);
}

export function formatForEmbedding(
  model: string,
  purpose: EmbeddingPurpose,
  text: string,
  title?: string,
): string {
  if (supportsTaskType(model)) {
    return purpose === "document" && title ? `${title}\n\n${text}` : text;
  }
  return purpose === "query"
    ? `task: search result | query: ${text}`
    : `title: ${title ?? "none"} | text: ${text}`;
}

export async function geminiEmbed(
  ai: GoogleGenAI,
  model: string,
  dimensions: number,
  request: EmbedRequest,
): Promise<EmbedResult> {
  const startedAt = Date.now();
  const embeddings: number[][] = [];

  for (let offset = 0; offset < request.texts.length; offset += BATCH_SIZE) {
    const batch = request.texts
      .slice(offset, offset + BATCH_SIZE)
      .map((text, i) =>
        formatForEmbedding(model, request.purpose, text, request.titles?.[offset + i]),
      );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await ai.models.embedContent({
        model,
        // One Content per text. A plain string[] is merged into a SINGLE embedding by the
        // multimodal gemini-embedding-2 (verified against the live API), which would silently give
        // N chunks one shared vector. The count check below guards against that regression.
        contents: batch.map((text) => ({ parts: [{ text }] })),
        config: {
          outputDimensionality: dimensions,
          abortSignal: controller.signal,
          ...(supportsTaskType(model)
            ? {
                taskType: request.purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
              }
            : {}),
        },
      });

      const values = response.embeddings?.map((embedding) => embedding.values);
      if (!values || values.length !== batch.length || values.some((v) => !Array.isArray(v))) {
        throw new AiEmbeddingError("embedding_count_mismatch");
      }
      embeddings.push(...(values as number[][]));
    } catch (error) {
      if (error instanceof AiEmbeddingError) throw error;
      if (controller.signal.aborted) throw new AiTimeoutError(error);
      log.error({ err: describeError(error), model }, "gemini embedding failed");
      throw new AiProviderError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    embeddings,
    model,
    provider: "gemini",
    dimensions,
    latencyMs: Date.now() - startedAt,
  };
}
