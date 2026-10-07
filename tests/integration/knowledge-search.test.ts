import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { requireOrganizationContext } from "@/server/auth/context";
import { toVectorLiteral } from "@/server/repositories/knowledge-chunks";
import { searchKnowledge } from "@/server/services/knowledge-retrieval";
import { archiveDocument } from "@/server/services/knowledge";
import { fakeEmbedding, installFakeAi, uninstallFakeAi, type FakeAiProvider } from "../helpers/ai";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import {
  REFUND_DOC,
  SHIPPING_DOC,
  chunksOf,
  createPublishedDocument,
  setupAiTenants,
} from "../helpers/knowledge";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const WARRANTY_DOC = {
  title: "Warranty",
  content: "Warranty covers manufacturing defects for two years from purchase.",
};

describeDb("vector search", () => {
  let t: Awaited<ReturnType<typeof setupAiTenants>>;
  let fake: FakeAiProvider;
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupAiTenants();
    fake = installFakeAi();
    as(t.adminA);
  });
  afterEach(uninstallFakeAi);
  afterAll(disconnectDatabase);

  const search = (
    query: string,
    extra: Partial<{ limit: number; minSimilarity: number; organizationId: string }> = {},
  ) =>
    searchKnowledge({ organizationId: t.orgA.id, query, limit: 5, minSimilarity: 0.2, ...extra });

  it("uses the pgvector extension with 768-dimensional vectors", async () => {
    const [extension] = await (
      await db()
    ).$queryRaw<{ extname: string }[]>`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    expect(extension.extname).toBe("vector");
    const ctx = await requireOrganizationContext();
    const doc = await createPublishedDocument(ctx, REFUND_DOC);
    expect((await chunksOf(doc.id))[0].dims).toBe(768);
  });

  it("returns the most similar chunks first, with source metadata and similarity scores", async () => {
    const ctx = await requireOrganizationContext();
    const refund = await createPublishedDocument(ctx, REFUND_DOC);
    await createPublishedDocument(ctx, SHIPPING_DOC);
    await createPublishedDocument(ctx, WARRANTY_DOC);

    const results = await search("how do I request a refund for my order", { minSimilarity: 0 });
    expect(results.length).toBeGreaterThan(1);
    expect(results[0]).toMatchObject({
      documentId: refund.id,
      documentTitle: "Refund policy",
      chunkIndex: 0,
    });
    expect(results[0].chunkId).toEqual(expect.any(String));
    expect(results[0].content).toContain("refund");
    // Sorted by similarity, best first, all within [0, 1].
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].similarity).toBeGreaterThanOrEqual(results[i].similarity);
    }
    expect(results[0].similarity).toBeGreaterThan(0.3);
    expect(results[0].similarity).toBeLessThanOrEqual(1.0000001);
  });

  it("never exposes embeddings", async () => {
    const ctx = await requireOrganizationContext();
    await createPublishedDocument(ctx, REFUND_DOC);
    const [result] = await search("refund");
    expect(Object.keys(result).sort()).toEqual(
      ["chunkId", "chunkIndex", "content", "documentId", "documentTitle", "similarity"].sort(),
    );
  });

  it("applies the relevance threshold in the database", async () => {
    const ctx = await requireOrganizationContext();
    await createPublishedDocument(ctx, REFUND_DOC);
    await createPublishedDocument(ctx, SHIPPING_DOC);

    expect(await search("completely unrelated astronomy telescope question")).toEqual([]);
    const relevant = await search("refund within 30 days");
    expect(relevant.map((r) => r.documentTitle)).toEqual(["Refund policy"]);

    // A stricter threshold removes weaker matches; 1.01 removes everything.
    const loose = await search("refund shipping", { minSimilarity: 0.1 });
    const strict = await search("refund shipping", { minSimilarity: 0.6 });
    expect(strict.length).toBeLessThan(loose.length);
    expect(await search("refund", { minSimilarity: 1.01 })).toEqual([]);
  });

  it("respects the result limit", async () => {
    const ctx = await requireOrganizationContext();
    for (const n of [1, 2, 3, 4]) {
      await createPublishedDocument(ctx, {
        title: `Refund note ${n}`,
        content: `Refund details number ${n}.`,
      });
    }
    expect(await search("refund details", { limit: 2, minSimilarity: 0 })).toHaveLength(2);
  });

  it("searches only PUBLISHED documents", async () => {
    const ctx = await requireOrganizationContext();
    const doc = await createPublishedDocument(ctx, REFUND_DOC);
    expect(await search("refund")).toHaveLength(1);

    // A draft/archived document with leftover chunks (simulated directly) must still be invisible.
    await (
      await db()
    ).knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "DRAFT", publishedAt: null },
    });
    expect(await search("refund")).toEqual([]);
    await (
      await db()
    ).knowledgeDocument.update({
      where: { id: doc.id },
      data: { status: "ARCHIVED", publishedAt: null },
    });
    expect(await search("refund")).toEqual([]);
  });

  it("excludes chunks that do not match their document's current version (stale vectors)", async () => {
    const ctx = await requireOrganizationContext();
    const doc = await createPublishedDocument(ctx, REFUND_DOC);
    expect(await search("refund")).toHaveLength(1);
    await (
      await db()
    ).knowledgeDocument.update({
      where: { id: doc.id },
      data: { contentVersion: { increment: 1 } },
    });
    expect(await search("refund")).toEqual([]);
  });

  it("does not return archived documents after archiving through the service", async () => {
    const ctx = await requireOrganizationContext();
    const doc = await createPublishedDocument(ctx, REFUND_DOC);
    await archiveDocument(ctx, doc.id);
    expect(await search("refund")).toEqual([]);
  });

  it("is isolated per organization in both directions, even with identical content", async () => {
    const ctxA = await requireOrganizationContext();
    const docA = await createPublishedDocument(ctxA, REFUND_DOC);
    as(t.ownerB);
    const ctxB = await requireOrganizationContext();
    const docB = await createPublishedDocument(ctxB, {
      ...REFUND_DOC,
      content: REFUND_DOC.content + " Org B only: 99 days.",
    });

    const forA = await search("refund within 30 days");
    expect(forA.map((r) => r.documentId)).toEqual([docA.id]);
    expect(JSON.stringify(forA)).not.toContain("Org B only");

    const forB = await searchKnowledge({
      organizationId: t.orgB.id,
      query: "refund within 30 days",
      limit: 5,
      minSimilarity: 0.2,
    });
    expect(forB.map((r) => r.documentId)).toEqual([docB.id]);
  });

  it("returns nothing for an organization without knowledge", async () => {
    const ctxA = await requireOrganizationContext();
    await createPublishedDocument(ctxA, REFUND_DOC);
    expect(
      await searchKnowledge({
        organizationId: t.orgB.id,
        query: "refund",
        limit: 5,
        minSimilarity: 0,
      }),
    ).toEqual([]);
  });

  it("skips the embedding call for empty queries and propagates provider failures", async () => {
    expect(await search("   ")).toEqual([]);
    expect(fake.embedCalls).toHaveLength(0);
    fake.embeddingError = new Error("embedding service down");
    await expect(search("refund")).rejects.toThrow("embedding service down");
  });

  it("embeds the query with the query purpose", async () => {
    await search("refund");
    expect(fake.embedCalls.at(-1)).toMatchObject({ purpose: "query", texts: ["refund"] });
  });

  it("scores identical text close to 1 (cosine similarity)", async () => {
    const ctx = await requireOrganizationContext();
    await createPublishedDocument(ctx, { title: "Exact", content: "alpha beta gamma delta" });
    // Same bag of words as the embedded chunk (title + content).
    const [hit] = await search("Exact alpha beta gamma delta", { minSimilarity: 0.9 });
    expect(hit.similarity).toBeGreaterThan(0.99);
  });

  it("builds well-formed vector literals and refuses malformed vectors", () => {
    expect(toVectorLiteral(fakeEmbedding("x"))).toMatch(/^\[(-?[\d.e+-]+,){767}-?[\d.e+-]+\]$/);
    expect(() => toVectorLiteral([1, 2, 3])).toThrow();
    expect(() => toVectorLiteral(new Array(768).fill(Number.NaN))).toThrow();
  });
});
