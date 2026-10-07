import { describe, expect, it } from "vitest";
import { knowledgeHref, parseKnowledgeListParams } from "./list-params";

describe("parseKnowledgeListParams", () => {
  it("parses valid params and falls back to defaults for invalid ones", () => {
    expect(parseKnowledgeListParams({ q: "refund", status: "PUBLISHED", page: "2" })).toMatchObject(
      {
        invalid: false,
        query: { q: "refund", status: ["PUBLISHED"], page: 2 },
      },
    );
    const bad = parseKnowledgeListParams({ status: "LIVE", page: "-1" });
    expect(bad.invalid).toBe(true);
    expect(bad.query).toMatchObject({ page: 1, sort: "updatedAt", order: "desc" });
  });
});

describe("knowledgeHref", () => {
  it("keeps filters, drops empty values and page 1", () => {
    expect(knowledgeHref({ q: "a", status: "DRAFT" }, { page: "1" })).toBe(
      "/dashboard/knowledge?q=a&status=DRAFT",
    );
    expect(knowledgeHref({ q: "a" }, { page: "3", q: undefined })).toBe(
      "/dashboard/knowledge?page=3",
    );
    expect(knowledgeHref({}, {})).toBe("/dashboard/knowledge");
  });
});
