import { chunkText } from "@/features/knowledge/chunking";
import { createLogger } from "@/lib/logger";
import { embedDocuments } from "@/server/ai/embeddings";
import type { NewChunk } from "@/server/repositories/knowledge-chunks";

const log = createLogger("knowledge.indexing");

/**
 * Chunks a document and embeds every chunk. This is the EXTERNAL step (Gemini) and is deliberately
 * separate from persistence: callers run it BEFORE opening the database transaction that swaps
 * chunks, because an external API call cannot take part in a PostgreSQL transaction. If it throws,
 * nothing has been written and the document keeps its previous, consistent state.
 */
export async function prepareChunks(title: string, content: string): Promise<NewChunk[]> {
  const chunks = chunkText(content);
  if (chunks.length === 0) return [];

  const embeddings = await embedDocuments(
    chunks.map((chunk) => chunk.content),
    chunks.map(() => title),
  );

  log.info({ chunks: chunks.length }, "prepared knowledge chunks");
  return chunks.map((chunk, i) => ({
    chunkIndex: chunk.chunkIndex,
    content: chunk.content,
    estimatedTokens: chunk.estimatedTokens,
    embedding: embeddings[i],
  }));
}
