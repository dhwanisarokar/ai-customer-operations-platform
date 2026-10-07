import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/knowledge/[documentId]/route";
import { POST as archiveRoute } from "@/app/api/knowledge/[documentId]/archive/route";
import { POST as publishRoute } from "@/app/api/knowledge/[documentId]/publish/route";
import { POST as unpublishRoute } from "@/app/api/knowledge/[documentId]/unpublish/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/knowledge/route";
import { AiProviderError } from "@/server/ai/errors";
import { requireOrganizationContext } from "@/server/auth/context";
import { searchKnowledge } from "@/server/services/knowledge-retrieval";
import { installFakeAi, uninstallFakeAi, type FakeAiProvider } from "../helpers/ai";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import {
  REFUND_DOC,
  SHIPPING_DOC,
  chunksOf,
  documentRow,
  setupAiTenants,
} from "../helpers/knowledge";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("knowledge base", () => {
  let t: Awaited<ReturnType<typeof setupAiTenants>>;
  let fake: FakeAiProvider;
  const id = (documentId: string) => ({ documentId });

  beforeEach(async () => {
    await resetDatabase();
    t = await setupAiTenants();
    fake = installFakeAi();
    as(t.memberA);
  });
  afterEach(uninstallFakeAi);
  afterAll(disconnectDatabase);

  const create = (body: Record<string, unknown>) => call(createRoute, { method: "POST", body });
  const patch = (docId: string, body: Record<string, unknown>) =>
    call(patchRoute, { method: "PATCH", params: id(docId), body });
  const post = (route: unknown, docId: string) =>
    call(route, { method: "POST", params: id(docId) });

  async function draft(doc: { title: string; content: string } = REFUND_DOC) {
    const res = await create(doc);
    expect(res.status).toBe(201);
    return res.body.document as { id: string };
  }
  async function published(doc: { title: string; content: string } = REFUND_DOC) {
    const { id: docId } = await draft(doc);
    as(t.adminA);
    const res = await post(publishRoute, docId);
    expect(res.status).toBe(200);
    return docId;
  }

  describe("create, read and list", () => {
    it("creates a draft in the caller's organization, recording the author", async () => {
      const res = await create({ ...REFUND_DOC, description: "  How refunds work " });
      expect(res.status).toBe(201);
      expect(res.body.document).toMatchObject({
        title: "Refund policy",
        description: "How refunds work",
        status: "DRAFT",
        contentVersion: 1,
        chunkCount: 0,
        createdBy: { id: t.memberA.id },
      });
      const row = await documentRow(res.body.document.id);
      expect(row.organizationId).toBe(t.orgA.id);
      expect(fake.embedCalls).toHaveLength(0); // drafts are never embedded
    });

    it.each([
      ["empty title", { title: "", content: "x" }],
      ["blank content", { title: "T", content: "   " }],
      ["status", { title: "T", content: "x", status: "PUBLISHED" }],
      ["organizationId", { title: "T", content: "x", organizationId: crypto.randomUUID() }],
      ["createdByUserId", { title: "T", content: "x", createdByUserId: t?.ownerB?.id ?? "x" }],
    ])("returns 400 for %s and creates nothing", async (_label, body) => {
      expect((await create(body)).status).toBe(400);
      const { getDb } = await import("@/db/client");
      expect(await getDb().knowledgeDocument.count()).toBe(0);
    });

    it("rejects malformed JSON and unauthenticated requests", async () => {
      expect((await call(createRoute, { method: "POST", rawBody: "{oops" })).status).toBe(400);
      const { signOut } = await import("../helpers/mocks");
      signOut();
      expect((await call(listRoute)).status).toBe(401);
    });

    it("returns the document with content, and 404 for unknown or malformed ids", async () => {
      const { id: docId } = await draft();
      const res = await call(getRoute, { params: id(docId) });
      expect(res.status).toBe(200);
      expect(res.body.document.content).toContain("30 days");
      expect((await call(getRoute, { params: id(crypto.randomUUID()) })).status).toBe(404);
      expect((await call(getRoute, { params: id("nope") })).status).toBe(404);
    });

    it("paginates, searches, filters by status and sorts", async () => {
      const refund = await draft(REFUND_DOC);
      await draft(SHIPPING_DOC);
      await draft({ title: "Account security", content: "Enable two factor authentication." });
      as(t.adminA);
      await post(publishRoute, refund.id);

      const all = await call(listRoute, { query: { sort: "title", order: "asc" } });
      expect(all.body.total).toBe(3);
      expect(all.body.items.map((d: { title: string }) => d.title)).toEqual([
        "Account security",
        "Refund policy",
        "Shipping times",
      ]);
      expect(all.body.items[0]).not.toHaveProperty("content");

      const page = await call(listRoute, {
        query: { sort: "title", order: "asc", pageSize: "2", page: "2" },
      });
      expect(page.body).toMatchObject({ total: 3, totalPages: 2 });
      expect(page.body.items.map((d: { title: string }) => d.title)).toEqual(["Shipping times"]);

      const byContent = await call(listRoute, { query: { q: "factor" } });
      expect(byContent.body.items.map((d: { title: string }) => d.title)).toEqual([
        "Account security",
      ]);
      expect((await call(listRoute, { query: { q: "%" } })).body.total).toBe(0);

      const publishedOnly = await call(listRoute, { query: { status: "PUBLISHED" } });
      expect(publishedOnly.body.items).toHaveLength(1);
      expect(publishedOnly.body.items[0]).toMatchObject({ title: "Refund policy", chunkCount: 1 });
      expect((await call(listRoute, { query: { status: "NOPE" } })).status).toBe(400);
    });
  });

  describe("editing drafts", () => {
    it("lets a member edit a draft without any embedding work, bumping the version", async () => {
      const { id: docId } = await draft();
      const res = await patch(docId, { title: "  Refunds  ", content: "New body" });
      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({
        title: "Refunds",
        content: "New body",
        contentVersion: 2,
      });
      expect(res.body.document.updatedBy.id).toBe(t.memberA.id);
      expect(fake.embedCalls).toHaveLength(0);
    });

    it("is a no-op when nothing changes, and rejects empty or server-owned fields", async () => {
      const { id: docId } = await draft();
      expect((await patch(docId, { title: "Refund policy" })).body.document.contentVersion).toBe(1);
      expect((await patch(docId, {})).status).toBe(400);
      for (const body of [
        { status: "PUBLISHED" },
        { contentVersion: 9 },
        { organizationId: t.orgB.id },
      ]) {
        expect((await patch(docId, body)).status).toBe(400);
      }
    });
  });

  describe("publishing", () => {
    it("lets only ADMIN and above publish; members get 403 and nothing is embedded", async () => {
      const { id: docId } = await draft();
      expect((await post(publishRoute, docId)).status).toBe(403);
      expect((await post(unpublishRoute, docId)).status).toBe(403);
      expect((await post(archiveRoute, docId)).status).toBe(403);
      expect((await call(deleteRoute, { method: "DELETE", params: id(docId) })).status).toBe(403);
      expect(fake.embedCalls).toHaveLength(0);
      expect((await documentRow(docId)).status).toBe("DRAFT");
    });

    it("chunks and embeds the content with 768-dimensional vectors, then marks it published", async () => {
      const { id: docId } = await draft();
      as(t.adminA);
      const res = await post(publishRoute, docId);
      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({ status: "PUBLISHED", chunkCount: 1 });
      expect(res.body.document.publishedAt).not.toBeNull();

      const chunks = await chunksOf(docId);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]).toMatchObject({ chunkIndex: 0, dims: 768, contentVersion: 1 });
      expect(fake.embedCalls).toHaveLength(1);
      expect(fake.embedCalls[0]).toMatchObject({ purpose: "document", titles: ["Refund policy"] });
    });

    it("creates several ordered chunks for long documents", async () => {
      const paragraphs = Array.from(
        { length: 6 },
        (_, i) => `Section ${i} ` + "alpha beta gamma ".repeat(120),
      );
      const { id: docId } = await draft({ title: "Long guide", content: paragraphs.join("\n\n") });
      as(t.adminA);
      await post(publishRoute, docId);
      const chunks = await chunksOf(docId);
      expect(chunks.length).toBeGreaterThan(2);
      expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
      expect(chunks.every((c) => c.dims === 768)).toBe(true);
    });

    it("is idempotent for an already published document", async () => {
      const docId = await published();
      const before = fake.embedCalls.length;
      expect((await post(publishRoute, docId)).status).toBe(200);
      expect(fake.embedCalls).toHaveLength(before);
    });

    it("leaves the document a clean draft when embedding fails (no half-published state)", async () => {
      const { id: docId } = await draft();
      fake.embeddingError = new AiProviderError(new Error("upstream down"));
      as(t.adminA);
      const res = await post(publishRoute, docId);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe("ai_unavailable");
      expect(JSON.stringify(res.body)).not.toContain("upstream");
      expect(await documentRow(docId)).toMatchObject({ status: "DRAFT", publishedAt: null });
      expect(await chunksOf(docId)).toHaveLength(0);
    });

    it("rejects invalid embeddings from the provider without storing anything", async () => {
      const { id: docId } = await draft();
      fake.embeddingTransform = (vectors) => vectors.map((v) => v.slice(0, 10));
      as(t.adminA);
      expect((await post(publishRoute, docId)).status).toBe(502);
      expect(await chunksOf(docId)).toHaveLength(0);
      expect((await documentRow(docId)).status).toBe("DRAFT");
    });

    it("refuses to publish an archived document until it is restored", async () => {
      const { id: docId } = await draft();
      as(t.adminA);
      await post(archiveRoute, docId);
      expect((await post(publishRoute, docId)).status).toBe(409);
      expect((await post(unpublishRoute, docId)).body.document.status).toBe("DRAFT");
      expect((await post(publishRoute, docId)).status).toBe(200);
    });
  });

  describe("editing published documents (stale embeddings)", () => {
    it("requires ADMIN to edit live content; members get 403 and nothing changes", async () => {
      const docId = await published();
      as(t.memberA);
      expect((await patch(docId, { content: "Changed" })).status).toBe(403);
      expect((await documentRow(docId)).content).toBe(REFUND_DOC.content);
    });

    it("re-chunks and re-embeds atomically: old chunks are replaced, version advances", async () => {
      const docId = await published();
      const [oldChunk] = await chunksOf(docId);
      as(t.adminA);
      const res = await patch(docId, {
        content: "Returns are accepted for sixty days after delivery.",
      });
      expect(res.status).toBe(200);
      expect(res.body.document).toMatchObject({
        contentVersion: 2,
        status: "PUBLISHED",
        chunkCount: 1,
      });

      const chunks = await chunksOf(docId);
      expect(chunks).toHaveLength(1);
      expect(chunks[0].id).not.toBe(oldChunk.id);
      expect(chunks[0]).toMatchObject({
        contentVersion: 2,
        content: "Returns are accepted for sixty days after delivery.",
      });
      expect(fake.embedCalls).toHaveLength(2);
    });

    it("never retrieves the old content after an edit", async () => {
      const docId = await published();
      const ctx = await requireOrganizationContext();
      expect(
        (
          await searchKnowledge({
            organizationId: ctx.organization.id,
            query: "refund within 30 days",
            limit: 5,
          })
        ).length,
      ).toBe(1);

      as(t.adminA);
      await patch(docId, { content: "Warranty covers manufacturing defects for two years." });
      const stale = await searchKnowledge({
        organizationId: t.orgA.id,
        query: "refund within 30 days",
        limit: 5,
        minSimilarity: 0.2,
      });
      expect(stale).toEqual([]);
      const fresh = await searchKnowledge({
        organizationId: t.orgA.id,
        query: "warranty manufacturing defects",
        limit: 5,
        minSimilarity: 0.2,
      });
      expect(fresh[0].content).toContain("Warranty");
    });

    it("re-embeds when only the title changes (the title is part of the embedded text), not for the description", async () => {
      const docId = await published();
      as(t.adminA);
      await patch(docId, { description: "internal note about this doc" });
      expect(fake.embedCalls).toHaveLength(1);
      expect((await documentRow(docId)).contentVersion).toBe(1);

      await patch(docId, { title: "Returns policy" });
      expect(fake.embedCalls).toHaveLength(2);
      expect(fake.embedCalls[1].titles).toEqual(["Returns policy"]);
      expect((await documentRow(docId)).contentVersion).toBe(2);
    });

    it("keeps the previous content AND chunks consistent when embedding fails during an edit", async () => {
      const docId = await published();
      const [oldChunk] = await chunksOf(docId);
      as(t.adminA);
      fake.embeddingError = new AiProviderError(new Error("rate limited"));
      const res = await patch(docId, { content: "Completely different text about warranty." });
      expect(res.status).toBe(502);

      expect(await documentRow(docId)).toMatchObject({
        content: REFUND_DOC.content,
        contentVersion: 1,
        status: "PUBLISHED",
      });
      const chunks = await chunksOf(docId);
      expect(chunks.map((c) => c.id)).toEqual([oldChunk.id]);
    });

    it("detects concurrent edits instead of mixing them (409) and leaves one consistent version", async () => {
      const docId = await published();
      as(t.adminA);
      fake.embedDelayMs = 60; // both requests read version 1 before either commits
      const [a, b] = await Promise.all([
        patch(docId, { content: "First edit about warranty coverage." }),
        patch(docId, { content: "Second edit about shipping carriers." }),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);

      const row = await documentRow(docId);
      expect(row.contentVersion).toBe(2);
      const chunks = await chunksOf(docId);
      expect(chunks.every((c) => c.contentVersion === row.contentVersion)).toBe(true);
      expect(chunks.map((c) => c.content).join(" ")).toContain(row.content.slice(0, 20));
    });
  });

  describe("unpublish, archive and delete", () => {
    it("unpublishing removes embeddings and makes the content unsearchable", async () => {
      const docId = await published();
      const res = await post(unpublishRoute, docId);
      expect(res.body.document).toMatchObject({
        status: "DRAFT",
        publishedAt: null,
        chunkCount: 0,
      });
      expect(await chunksOf(docId)).toHaveLength(0);
      expect(
        await searchKnowledge({
          organizationId: t.orgA.id,
          query: "refund",
          limit: 5,
          minSimilarity: 0,
        }),
      ).toEqual([]);
    });

    it("archiving removes embeddings; archived documents can still be read and listed", async () => {
      const docId = await published();
      const res = await post(archiveRoute, docId);
      expect(res.body.document.status).toBe("ARCHIVED");
      expect(await chunksOf(docId)).toHaveLength(0);
      expect((await call(getRoute, { params: id(docId) })).status).toBe(200);
      expect((await call(listRoute, { query: { status: "ARCHIVED" } })).body.total).toBe(1);
    });

    it("deleting removes the document and its chunks permanently", async () => {
      const docId = await published();
      const res = await call(deleteRoute, { method: "DELETE", params: id(docId) });
      expect(res.status).toBe(204);
      expect(await chunksOf(docId)).toHaveLength(0);
      expect((await call(getRoute, { params: id(docId) })).status).toBe(404);
      expect((await call(deleteRoute, { method: "DELETE", params: id(docId) })).status).toBe(404);
    });
  });

  describe("tenant isolation", () => {
    it("hides another organization's documents on every endpoint without side effects", async () => {
      as(t.ownerB);
      const created = await create({ ...REFUND_DOC });
      const docB = created.body.document.id as string;
      await post(publishRoute, docB);
      const calls = fake.embedCalls.length;

      as(t.ownerA);
      const results = await Promise.all([
        call(getRoute, { params: id(docB) }),
        patch(docB, { title: "Hijacked" }),
        post(publishRoute, docB),
        post(unpublishRoute, docB),
        post(archiveRoute, docB),
        call(deleteRoute, { method: "DELETE", params: id(docB) }),
      ]);
      expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404, 404]);
      for (const r of results) expect(JSON.stringify(r.body)).not.toContain("Refund policy");

      expect(fake.embedCalls).toHaveLength(calls);
      expect(await documentRow(docB)).toMatchObject({
        title: "Refund policy",
        status: "PUBLISHED",
      });
      expect(await chunksOf(docB)).toHaveLength(1);
      expect((await call(listRoute)).body.total).toBe(0);
      expect((await call(listRoute, { query: { organizationId: t.orgB.id } })).body.total).toBe(0);
    });
  });
});
