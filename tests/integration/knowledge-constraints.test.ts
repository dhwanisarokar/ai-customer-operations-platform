import { afterAll, beforeEach, expect, it } from "vitest";
import { toVectorLiteral } from "@/server/repositories/knowledge-chunks";
import { fakeEmbedding } from "../helpers/ai";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { setupAiTenants } from "../helpers/knowledge";

describeDb("knowledge database integrity", () => {
  let t: Awaited<ReturnType<typeof setupAiTenants>>;
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupAiTenants();
  });
  afterAll(disconnectDatabase);

  async function doc(
    organizationId: string,
    extra: { status?: string; publishedAt?: string } = {},
  ) {
    const client = await db();
    const row = await client.knowledgeDocument.create({
      data: { organizationId, title: "T", content: "C", ...(extra as object) },
    });
    return row.id;
  }

  async function insertChunk(
    organizationId: string,
    documentId: string,
    options: { chunkIndex?: number; content?: string; vector?: string; tokens?: number } = {},
  ) {
    const vector = options.vector ?? toVectorLiteral(fakeEmbedding("hello world"));
    return (await db()).$executeRawUnsafe(
      `INSERT INTO knowledge_document_chunks (id, "organizationId", "documentId", "chunkIndex", content, "estimatedTokens", "contentVersion", embedding)
       VALUES (gen_random_uuid(), '${organizationId}', '${documentId}', ${options.chunkIndex ?? 0}, '${options.content ?? "text"}', ${options.tokens ?? 5}, 1, '${vector}'::vector)`,
    );
  }

  it("rejects a chunk whose organization differs from its document's (composite foreign key)", async () => {
    const docA = await doc(t.orgA.id);
    await expect(insertChunk(t.orgB.id, docA)).rejects.toThrow();
    await expect(insertChunk(t.orgA.id, docA)).resolves.toBe(1);
  });

  it("rejects embeddings of the wrong dimension at the database level", async () => {
    const docA = await doc(t.orgA.id);
    await expect(insertChunk(t.orgA.id, docA, { vector: "[1,2,3]" })).rejects.toThrow();
    const tooLong = `[${new Array(1536).fill(0.1).join(",")}]`;
    await expect(insertChunk(t.orgA.id, docA, { vector: tooLong })).rejects.toThrow();
  });

  it("enforces unique chunk indexes per document and valid chunk values", async () => {
    const docA = await doc(t.orgA.id);
    await insertChunk(t.orgA.id, docA, { chunkIndex: 0 });
    await expect(insertChunk(t.orgA.id, docA, { chunkIndex: 0 })).rejects.toThrow();
    await expect(insertChunk(t.orgA.id, docA, { chunkIndex: -1 })).rejects.toThrow();
    await expect(insertChunk(t.orgA.id, docA, { chunkIndex: 1, content: "   " })).rejects.toThrow();
    await expect(insertChunk(t.orgA.id, docA, { chunkIndex: 2, tokens: 0 })).rejects.toThrow();
  });

  it("checks document titles, versions and published-at consistency", async () => {
    const client = await db();
    await expect(
      client.knowledgeDocument.create({
        data: { organizationId: t.orgA.id, title: "  ", content: "x" },
      }),
    ).rejects.toThrow();
    await expect(
      client.knowledgeDocument.create({
        data: { organizationId: t.orgA.id, title: "T", content: "x", status: "PUBLISHED" },
      }),
    ).rejects.toThrow();
    await expect(
      client.knowledgeDocument.create({
        data: {
          organizationId: t.orgA.id,
          title: "T",
          content: "x",
          status: "PUBLISHED",
          publishedAt: new Date(),
        },
      }),
    ).resolves.toBeDefined();
    await expect(
      client.knowledgeDocument.create({
        data: { organizationId: t.orgA.id, title: "T", content: "x", contentVersion: 0 },
      }),
    ).rejects.toThrow();
  });

  it("rejects invalid status values", async () => {
    await expect(
      (await db()).$executeRawUnsafe(
        `INSERT INTO knowledge_documents (id, "organizationId", title, content, status) VALUES (gen_random_uuid(), '${t.orgA.id}', 'T', 'C', 'LIVE')`,
      ),
    ).rejects.toThrow();
  });

  it("cascades: deleting a document removes its chunks, deleting an organization removes everything", async () => {
    const client = await db();
    const docA = await doc(t.orgA.id);
    const docB = await doc(t.orgB.id);
    await insertChunk(t.orgA.id, docA);
    await insertChunk(t.orgB.id, docB);

    await client.knowledgeDocument.delete({ where: { id: docA } });
    expect(
      await client.knowledgeDocumentChunk.count({ where: { organizationId: t.orgA.id } }),
    ).toBe(0);
    expect(
      await client.knowledgeDocumentChunk.count({ where: { organizationId: t.orgB.id } }),
    ).toBe(1);

    await client.organization.delete({ where: { id: t.orgB.id } });
    expect(await client.knowledgeDocument.count({ where: { organizationId: t.orgB.id } })).toBe(0);
    expect(await client.knowledgeDocumentChunk.count()).toBe(0);
  });

  it("keeps a document when its author is deleted", async () => {
    const client = await db();
    const row = await client.knowledgeDocument.create({
      data: { organizationId: t.orgA.id, title: "T", content: "C", createdByUserId: t.memberA.id },
    });
    await client.user.delete({ where: { id: t.memberA.id } });
    expect(
      (await client.knowledgeDocument.findUniqueOrThrow({ where: { id: row.id } })).createdByUserId,
    ).toBeNull();
  });

  it("rejects AI_AGENT messages that carry a user id and accepts the intended shape", async () => {
    const client = await db();
    const conversation = await client.conversation.create({
      data: {
        organizationId: t.orgA.id,
        customerId: t.customerA.id,
        subject: "S",
        lastMessageAt: new Date(),
      },
    });
    const insert = (userId: string | null) =>
      client.$executeRawUnsafe(
        `INSERT INTO messages (id, "organizationId", "conversationId", "senderType", "senderUserId", "messageType", body, metadata)
         VALUES (gen_random_uuid(), '${t.orgA.id}', '${conversation.id}', 'AI_AGENT', ${userId ? `'${userId}'` : "NULL"}, 'MESSAGE', 'hi', '{"kind":"ai_reply"}'::jsonb)`,
      );
    await expect(insert(t.memberA.id)).rejects.toThrow();
    await expect(insert(null)).resolves.toBe(1);
  });

  it("has the expected tenant index on chunks", async () => {
    const rows = await (
      await db()
    ).$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE tablename = 'knowledge_document_chunks'`;
    expect(rows.map((r) => r.indexdef).join(" | ")).toContain('("organizationId", "documentId")');
  });
});
