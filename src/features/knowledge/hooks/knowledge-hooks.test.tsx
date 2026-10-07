// @vitest-environment jsdom
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { knowledgeKeys } from "@/lib/query/query-keys";
import {
  TEST_ORG,
  apiError,
  createTestQueryClient,
  deferred,
  json,
  mockApi,
  noContent,
  renderHookWithQuery,
} from "../../../../tests/helpers/query";
import type { KnowledgeDocumentResponse, KnowledgeListResponse } from "../api/types";
import { listDocumentsQuerySchema } from "../schemas";
import {
  useArchiveKnowledgeDocument,
  useCreateKnowledgeDocument,
  useDeleteKnowledgeDocument,
  usePublishKnowledgeDocument,
  useUnpublishKnowledgeDocument,
  useUpdateKnowledgeDocument,
} from "./mutations";
import { useKnowledgeDocument, useKnowledgeDocuments } from "./queries";

afterEach(() => vi.unstubAllGlobals());

const doc = (
  overrides: Partial<KnowledgeDocumentResponse["document"]> = {},
): KnowledgeDocumentResponse => ({
  document: {
    id: "d1",
    title: "Refund policy",
    description: null,
    content: "Refunds within 30 days.",
    status: "DRAFT",
    contentVersion: 1,
    publishedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    createdBy: { id: "u1", name: "Dana", email: "dana@example.com" },
    updatedBy: { id: "u1", name: "Dana", email: "dana@example.com" },
    chunkCount: 0,
    ...overrides,
  },
});

const detailKey = knowledgeKeys.detail(TEST_ORG, "d1");
const values = { title: "T", description: "", content: "C" };

describe("knowledge queries", () => {
  it("loads a filtered, paginated list using the query's parameters", async () => {
    const api = mockApi({
      "GET /api/knowledge": () =>
        json(200, {
          items: [],
          page: 2,
          pageSize: 10,
          total: 0,
          totalPages: 1,
        } satisfies KnowledgeListResponse),
    });
    const q = listDocumentsQuerySchema.parse({
      q: "refund",
      status: "PUBLISHED",
      page: "2",
      pageSize: "10",
      sort: "title",
      order: "asc",
    });
    const { result } = renderHookWithQuery(() => useKnowledgeDocuments(q));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const params = Object.fromEntries(new URL(api.calls[0].url, "http://x").searchParams);
    expect(params).toMatchObject({
      q: "refund",
      status: "PUBLISHED",
      page: "2",
      pageSize: "10",
      sort: "title",
      order: "asc",
    });
  });

  it("loads a document and reports a missing one as a non-retried error", async () => {
    const api = mockApi({
      "GET /api/knowledge/d1": () => apiError(404, "not_found", "Document not found"),
    });
    const { result } = renderHookWithQuery(() => useKnowledgeDocument("d1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(api.calls).toHaveLength(1);
    expect(result.current.error).toMatchObject({ status: 404 });
  });
});

describe("publishing (not optimistic)", () => {
  it("stays a draft while indexing runs, shows pending, then adopts the server's published document", async () => {
    const client = createTestQueryClient();
    client.setQueryData(detailKey, doc());
    const gate = deferred<Response>();
    mockApi({ "POST /api/knowledge/d1/publish": () => gate.promise });
    const { result } = renderHookWithQuery(() => usePublishKnowledgeDocument("d1"), { client });

    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isPending).toBe(true));
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document.status).toBe(
      "DRAFT",
    );

    gate.resolve(
      json(
        200,
        doc({ status: "PUBLISHED", publishedAt: "2026-01-02T00:00:00.000Z", chunkCount: 3 }),
      ),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document).toMatchObject({
      status: "PUBLISHED",
      chunkCount: 3,
    });
  });

  it("leaves the cached document unchanged and shows the safe error when embedding fails", async () => {
    const client = createTestQueryClient();
    client.setQueryData(detailKey, doc());
    mockApi({
      "POST /api/knowledge/d1/publish": () =>
        apiError(502, "ai_embedding_failed", "Could not generate embeddings. Please try again."),
    });
    const { result } = renderHookWithQuery(() => usePublishKnowledgeDocument("d1"), { client });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Could not generate embeddings. Please try again.");
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document.status).toBe(
      "DRAFT",
    );
  });

  it("refetches the knowledge list and detail afterwards (success or failure)", async () => {
    const client = createTestQueryClient();
    const api = mockApi({
      "POST /api/knowledge/d1/publish": () => json(200, doc({ status: "PUBLISHED" })),
      "GET /api/knowledge/d1": () => json(200, doc({ status: "PUBLISHED", chunkCount: 1 })),
      "GET /api/knowledge?": () =>
        json(200, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 }),
    });
    const { result } = renderHookWithQuery(
      () => ({
        m: usePublishKnowledgeDocument("d1"),
        d: useKnowledgeDocument("d1"),
        l: useKnowledgeDocuments(listDocumentsQuerySchema.parse({})),
      }),
      { client },
    );
    await waitFor(() =>
      expect(result.current.d.isSuccess && result.current.l.isSuccess).toBe(true),
    );
    api.calls.length = 0;
    act(() => result.current.m.mutate());
    await waitFor(() => expect(api.count("GET", "/api/knowledge/d1")).toBe(1));
    await waitFor(() => expect(api.count("GET", "/api/knowledge?")).toBe(1));
  });

  it("unpublish and archive call their own endpoints and cache the server's result", async () => {
    const client = createTestQueryClient();
    client.setQueryData(detailKey, doc({ status: "PUBLISHED" }));
    const api = mockApi({
      "POST /api/knowledge/d1/unpublish": () => json(200, doc({ status: "DRAFT" })),
      "POST /api/knowledge/d1/archive": () => json(200, doc({ status: "ARCHIVED" })),
    });
    const unpublish = renderHookWithQuery(() => useUnpublishKnowledgeDocument("d1"), { client });
    act(() => unpublish.result.current.mutate());
    await waitFor(() => expect(unpublish.result.current.isSuccess).toBe(true));
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document.status).toBe(
      "DRAFT",
    );

    const archive = renderHookWithQuery(() => useArchiveKnowledgeDocument("d1"), { client });
    act(() => archive.result.current.mutate());
    await waitFor(() => expect(archive.result.current.isSuccess).toBe(true));
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document.status).toBe(
      "ARCHIVED",
    );
    expect(api.calls.map((c) => c.url)).toEqual([
      "/api/knowledge/d1/unpublish",
      "/api/knowledge/d1/archive",
    ]);
  });
});

describe("create, update and delete", () => {
  it("creating seeds the detail cache and refreshes lists", async () => {
    const client = createTestQueryClient();
    mockApi({ "POST /api/knowledge": () => json(201, doc({ id: "new" })) });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useCreateKnowledgeDocument(), { client });
    act(() => result.current.mutate(values));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      client.getQueryData<KnowledgeDocumentResponse>(knowledgeKeys.detail(TEST_ORG, "new"))!
        .document.id,
    ).toBe("new");
    expect(spy).toHaveBeenCalledWith({ queryKey: knowledgeKeys.lists(TEST_ORG) });
  });

  it("updating stores the server's document; a conflict is surfaced and leaves the cache alone", async () => {
    const client = createTestQueryClient();
    client.setQueryData(detailKey, doc());
    mockApi({
      "PATCH /api/knowledge/d1": () => json(200, doc({ title: "Renamed", contentVersion: 2 })),
    });
    const { result } = renderHookWithQuery(() => useUpdateKnowledgeDocument("d1"), { client });
    act(() => result.current.mutate(values));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document).toMatchObject({
      title: "Renamed",
      contentVersion: 2,
    });

    mockApi({
      "PATCH /api/knowledge/d1": () =>
        apiError(409, "conflict", "The document was changed by someone else. Reload and retry."),
    });
    act(() => result.current.mutate(values));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toContain("changed by someone else");
    expect(client.getQueryData<KnowledgeDocumentResponse>(detailKey)!.document.title).toBe(
      "Renamed",
    );
  });

  it("deleting removes the cached detail and refreshes lists", async () => {
    const client = createTestQueryClient();
    client.setQueryData(detailKey, doc());
    mockApi({ "DELETE /api/knowledge/d1": () => noContent() });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useDeleteKnowledgeDocument("d1"), { client });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(client.getQueryData(detailKey)).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ queryKey: knowledgeKeys.lists(TEST_ORG) });
  });
});
