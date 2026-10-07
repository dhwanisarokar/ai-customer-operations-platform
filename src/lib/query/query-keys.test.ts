import { hashKey } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  conversationsKeys,
  customersKeys,
  knowledgeKeys,
  membersKeys,
  mutationKeys,
  tagsKeys,
} from "./query-keys";

const isPrefix = (prefix: readonly unknown[], key: readonly unknown[]) =>
  prefix.every((part, i) => hashKey([part]) === hashKey([key[i]]));

describe("query keys", () => {
  it("namespace every key by organization, so tenants never share a cache entry", () => {
    const params = { page: 1 };
    expect(hashKey(customersKeys.list("org-a", params))).not.toBe(
      hashKey(customersKeys.list("org-b", params)),
    );
    expect(hashKey(conversationsKeys.detail("org-a", "1"))).not.toBe(
      hashKey(conversationsKeys.detail("org-b", "1")),
    );
    expect(hashKey(knowledgeKeys.list("org-a", params))).not.toBe(
      hashKey(knowledgeKeys.list("org-b", params)),
    );
    expect(hashKey(tagsKeys.list("org-a"))).not.toBe(hashKey(tagsKeys.list("org-b")));
    expect(hashKey(membersKeys.list("org-a"))).not.toBe(hashKey(membersKeys.list("org-b")));
    for (const key of [
      customersKeys.all("org-a"),
      conversationsKeys.all("org-a"),
      knowledgeKeys.all("org-a"),
    ]) {
      expect(key.slice(0, 2)).toEqual(["org", "org-a"]);
    }
  });

  it("uses a distinct namespace when there is no organization yet", () => {
    expect(customersKeys.all(null)).toEqual(["org", "none", "customers"]);
  });

  it("includes every parameter that changes the result", () => {
    const base = { page: 1, pageSize: 25, q: "", sort: "createdAt", order: "desc" };
    const variants = [
      { ...base, page: 2 },
      { ...base, pageSize: 50 },
      { ...base, q: "ada" },
      { ...base, sort: "name" },
      { ...base, order: "asc" },
      { ...base, status: ["ARCHIVED"] },
    ];
    const hashes = new Set([base, ...variants].map((p) => hashKey(customersKeys.list("o", p))));
    expect(hashes.size).toBe(variants.length + 1);
  });

  it("is insensitive to property order but sensitive to values", () => {
    expect(hashKey(customersKeys.list("o", { a: 1, b: 2 }))).toBe(
      hashKey(customersKeys.list("o", { b: 2, a: 1 })),
    );
  });

  it("keeps customer-facing and staff message views in separate entries", () => {
    const customerFacing = conversationsKeys.messages("o", "c1", {
      limit: 50,
      includeInternal: false,
    });
    const staff = conversationsKeys.messages("o", "c1", { limit: 50, includeInternal: true });
    const longer = conversationsKeys.messages("o", "c1", { limit: 100, includeInternal: true });
    expect(new Set([hashKey(customerFacing), hashKey(staff), hashKey(longer)]).size).toBe(3);
  });

  it("is hierarchical, so prefixes invalidate the right families and nothing else", () => {
    const list = customersKeys.list("o", { page: 1 });
    const detail = customersKeys.detail("o", "c1");
    const notes = customersKeys.notes("o", "c1", { page: 1 });
    expect(isPrefix(customersKeys.lists("o"), list)).toBe(true);
    expect(isPrefix(customersKeys.lists("o"), detail)).toBe(false);
    expect(isPrefix(customersKeys.item("o", "c1"), detail)).toBe(true);
    expect(isPrefix(customersKeys.item("o", "c1"), notes)).toBe(true);
    expect(isPrefix(customersKeys.item("o", "c2"), notes)).toBe(false);

    const messages = conversationsKeys.messages("o", "c1", { limit: 50, includeInternal: true });
    expect(isPrefix(conversationsKeys.messagesAll("o", "c1"), messages)).toBe(true);
    expect(isPrefix(conversationsKeys.messagesAll("o", "c2"), messages)).toBe(false);
    expect(isPrefix(conversationsKeys.lists("o"), conversationsKeys.detail("o", "c1"))).toBe(false);
  });

  it("builds mutation keys under the conversation they act on", () => {
    expect(isPrefix(conversationsKeys.item("o", "c1"), mutationKeys.aiDraft("o", "c1"))).toBe(true);
    expect(hashKey(mutationKeys.aiDraft("o", "c1"))).not.toBe(
      hashKey(mutationKeys.aiDraft("o", "c2")),
    );
  });
});
