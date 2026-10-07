import { describe, expect, it } from "vitest";
import { customersHref, flattenSearchParams, parseListParams, toApiQuery } from "./list-params";

describe("flattenSearchParams", () => {
  it("keeps first values and drops empties", () => {
    expect(flattenSearchParams({ q: "ada", tag: ["a", "b"], empty: "", none: undefined })).toEqual({
      q: "ada",
      tag: "a",
    });
  });
});

describe("toApiQuery", () => {
  it("maps ALL to includeArchived and date inputs to UTC day boundaries", () => {
    expect(
      toApiQuery({ status: "ALL", createdFrom: "2026-01-02", createdTo: "2026-01-03" }),
    ).toEqual({
      includeArchived: "true",
      createdFrom: "2026-01-02T00:00:00.000Z",
      createdTo: "2026-01-03T23:59:59.999Z",
    });
  });
});

describe("parseListParams", () => {
  it("accepts valid params", () => {
    const { query, invalid } = parseListParams({ q: "ada", page: "2", status: "ARCHIVED" });
    expect(invalid).toBe(false);
    expect(query).toMatchObject({ q: "ada", page: 2, status: ["ARCHIVED"] });
  });

  it("falls back to defaults and flags invalid input instead of throwing", () => {
    const { query, invalid } = parseListParams({ page: "-3", sort: "email" });
    expect(invalid).toBe(true);
    expect(query).toMatchObject({ page: 1, pageSize: 25, sort: "createdAt", order: "desc" });
  });
});

describe("customersHref", () => {
  it("preserves filters, drops defaults and empty values", () => {
    expect(customersHref({ q: "ada", status: "ACTIVE" }, { page: "1" })).toBe(
      "/dashboard/customers?q=ada&status=ACTIVE",
    );
    expect(customersHref({ q: "ada" }, { page: "3", q: undefined })).toBe(
      "/dashboard/customers?page=3",
    );
    expect(customersHref({}, {})).toBe("/dashboard/customers");
  });
});
