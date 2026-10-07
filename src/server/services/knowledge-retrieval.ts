import { createLogger } from "@/lib/logger";
import { getAiConfig } from "@/server/ai/config";
import { embedQuery } from "@/server/ai/embeddings";
import {
  knowledgeChunksRepository,
  type RetrievedChunk,
} from "@/server/repositories/knowledge-chunks";

const log = createLogger("knowledge.retrieval");

export type { RetrievedChunk };

/**
 * Internal semantic search over ONE organization's PUBLISHED knowledge. Not exposed as an API:
 * callers (the AI agent) pass the organizationId from a verified OrganizationContext, never from
 * client input. Results below the relevance threshold are dropped, so an empty array means
 * "nothing relevant", not "nothing indexed".
 */
export async function searchKnowledge(input: {
  organizationId: string;
  query: string;
  limit: number;
  minSimilarity?: number;
}): Promise<RetrievedChunk[]> {
  const query = input.query.trim();
  if (!query) return [];

  const minSimilarity = input.minSimilarity ?? getAiConfig().minSimilarity;
  const embedding = await embedQuery(query);
  const results = await knowledgeChunksRepository.search(input.organizationId, embedding, {
    limit: input.limit,
    minSimilarity,
  });

  log.info(
    {
      organizationId: input.organizationId,
      results: results.length,
      topSimilarity: results[0]?.similarity ?? null,
      minSimilarity,
    },
    "knowledge search",
  );
  return results;
}
