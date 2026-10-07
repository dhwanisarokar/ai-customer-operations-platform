import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_LENGTH,
  createDocumentSchema,
  listDocumentsQuerySchema,
  updateDocumentSchema,
} from "./schemas";

describe("createDocumentSchema", () => {
  it("normalizes the title and treats a blank description as absent", () => {
    expect(
      createDocumentSchema.parse({
        title: "  Refund   policy ",
        description: " ",
        content: "Body",
      }),
    ).toEqual({ title: "Refund policy", description: null, content: "Body" });
  });

  it.each([
    ["missing title", { content: "x" }],
    ["blank title", { title: "  ", content: "x" }],
    ["long title", { title: "x".repeat(201), content: "x" }],
    ["missing content", { title: "x" }],
    ["blank content", { title: "x", content: "  \n " }],
    ["oversized content", { title: "x", content: "x".repeat(MAX_CONTENT_LENGTH + 1) }],
    ["long description", { title: "x", content: "x", description: "x".repeat(501) }],
    ["status", { title: "x", content: "x", status: "PUBLISHED" }],
    ["organizationId", { title: "x", content: "x", organizationId: crypto.randomUUID() }],
    ["createdByUserId", { title: "x", content: "x", createdByUserId: crypto.randomUUID() }],
  ])("rejects %s", (_label, input) => {
    expect(createDocumentSchema.safeParse(input).success).toBe(false);
  });
});

describe("updateDocumentSchema", () => {
  it("accepts partial updates; rejects empty bodies and server-owned fields", () => {
    expect(updateDocumentSchema.safeParse({ title: "New" }).success).toBe(true);
    expect(updateDocumentSchema.safeParse({}).success).toBe(false);
    for (const field of ["status", "contentVersion", "organizationId", "publishedAt", "id"]) {
      expect(updateDocumentSchema.safeParse({ [field]: "x" }).success).toBe(false);
    }
  });
});

describe("listDocumentsQuerySchema", () => {
  it("applies defaults and parses status lists", () => {
    expect(listDocumentsQuerySchema.parse({ status: "DRAFT,PUBLISHED" })).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: "updatedAt",
      order: "desc",
      status: ["DRAFT", "PUBLISHED"],
    });
  });

  it.each([{ status: "LIVE" }, { sort: "content" }, { pageSize: "101" }, { page: "0" }])(
    "rejects %j",
    (input) => {
      expect(listDocumentsQuerySchema.safeParse(input).success).toBe(false);
    },
  );
});
