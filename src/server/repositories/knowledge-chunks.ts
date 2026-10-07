import { getDb, type Db } from "@/db/client";
import { Prisma } from "@/generated/prisma/client";
import { EMBEDDING_DIMENSIONS } from "@/server/ai/config";

/**
 * Chunk persistence and vector search. Prisma cannot read or write the pgvector column, so this is
 * the one place with raw SQL. Every statement is parameterized (values are never interpolated into
 * the SQL text) and every statement filters on organizationId.
 */

export type NewChunk = {
  chunkIndex: number;
  content: string;
  estimatedTokens: number;
  embedding: number[];
};

export type RetrievedChunk = {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  /** Cosine similarity, 1 - cosine distance. Higher is more similar. */
  similarity: number;
};

/** pgvector text format: "[0.1,0.2,...]". Refuses anything but a finite, correctly sized vector. */
export function toVectorLiteral(vector: number[]): string {
  if (vector.length !== EMBEDDING_DIMENSIONS || !vector.every(Number.isFinite)) {
    throw new Error("Invalid embedding vector");
  }
  return `[${vector.join(",")}]`;
}

export const knowledgeChunksRepository = {
  /**
   * Replaces ALL chunks of a document with `rows`, tagged with `contentVersion`. Call inside the
   * same transaction that updates the document so readers never see a mix of old and new chunks.
   */
  async replaceForDocument(
    organizationId: string,
    documentId: string,
    contentVersion: number,
    rows: NewChunk[],
    db: Db = getDb(),
  ): Promise<void> {
    await db.$executeRaw`
      DELETE FROM knowledge_document_chunks
      WHERE "organizationId" = ${organizationId}::uuid AND "documentId" = ${documentId}::uuid`;
    if (rows.length === 0) return;

    const values = rows.map(
      (row) => Prisma.sql`(
        gen_random_uuid(), ${organizationId}::uuid, ${documentId}::uuid, ${row.chunkIndex},
        ${row.content}, ${row.estimatedTokens}, ${contentVersion}, ${toVectorLiteral(row.embedding)}::vector
      )`,
    );
    await db.$executeRaw`
      INSERT INTO knowledge_document_chunks
        (id, "organizationId", "documentId", "chunkIndex", content, "estimatedTokens", "contentVersion", embedding)
      VALUES ${Prisma.join(values)}`;
  },

  async deleteForDocument(
    organizationId: string,
    documentId: string,
    db: Db = getDb(),
  ): Promise<void> {
    await db.$executeRaw`
      DELETE FROM knowledge_document_chunks
      WHERE "organizationId" = ${organizationId}::uuid AND "documentId" = ${documentId}::uuid`;
  },

  /**
   * Exact cosine-similarity search within ONE organization, over PUBLISHED documents only, and only
   * chunks that match their document's current contentVersion (so stale vectors can never be
   * returned). The threshold and ordering run in PostgreSQL; nothing is ranked in JavaScript.
   * `<=>` is pgvector's cosine distance operator.
   */
  async search(
    organizationId: string,
    embedding: number[],
    options: { limit: number; minSimilarity: number },
    db: Db = getDb(),
  ): Promise<RetrievedChunk[]> {
    const vector = toVectorLiteral(embedding);
    return db.$queryRaw<RetrievedChunk[]>`
      SELECT c.id AS "chunkId",
             c."documentId" AS "documentId",
             d.title AS "documentTitle",
             c."chunkIndex" AS "chunkIndex",
             c.content AS content,
             (1 - (c.embedding <=> ${vector}::vector))::float8 AS similarity
      FROM knowledge_document_chunks c
      JOIN knowledge_documents d
        ON d.id = c."documentId" AND d."organizationId" = c."organizationId"
      WHERE c."organizationId" = ${organizationId}::uuid
        AND d."organizationId" = ${organizationId}::uuid
        AND d.status = 'PUBLISHED'
        AND c."contentVersion" = d."contentVersion"
        AND (1 - (c.embedding <=> ${vector}::vector)) >= ${options.minSimilarity}
      ORDER BY c.embedding <=> ${vector}::vector ASC, c."chunkIndex" ASC
      LIMIT ${options.limit}`;
  },
};
