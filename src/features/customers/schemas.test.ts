import { describe, expect, it } from "vitest";
import {
  assignTagSchema,
  createCustomerSchema,
  createNoteSchema,
  listCustomersQuerySchema,
  updateCustomerSchema,
} from "./schemas";

describe("createCustomerSchema", () => {
  it("normalizes input and applies defaults", () => {
    const parsed = createCustomerSchema.parse({
      firstName: "  Ada   Marie ",
      email: " ADA@Example.COM ",
      phone: "+1 (555) 010-9999",
      company: "  ",
    });
    expect(parsed).toMatchObject({
      firstName: "Ada Marie",
      email: "ada@example.com",
      phone: "+15550109999",
      company: null,
      lastName: null,
      status: "ACTIVE",
    });
  });

  it("treats blank email/phone as absent", () => {
    const parsed = createCustomerSchema.parse({ firstName: "Ada", email: "", phone: " " });
    expect(parsed.email).toBeNull();
    expect(parsed.phone).toBeNull();
  });

  it.each([
    ["missing first name", {}],
    ["blank first name", { firstName: "   " }],
    ["invalid email", { firstName: "A", email: "nope" }],
    ["invalid phone", { firstName: "A", phone: "call me" }],
    ["ARCHIVED status", { firstName: "A", status: "ARCHIVED" }],
    ["unknown status", { firstName: "A", status: "VIP" }],
    ["organizationId", { firstName: "A", organizationId: crypto.randomUUID() }],
    ["id", { firstName: "A", id: crypto.randomUUID() }],
    ["too-long company", { firstName: "A", company: "x".repeat(151) }],
  ])("rejects %s", (_label, input) => {
    expect(createCustomerSchema.safeParse(input).success).toBe(false);
  });
});

describe("updateCustomerSchema", () => {
  it("accepts partial updates and rejects empty or protected fields", () => {
    expect(updateCustomerSchema.safeParse({ company: "Acme" }).success).toBe(true);
    expect(updateCustomerSchema.safeParse({}).success).toBe(false);
    for (const field of ["id", "organizationId", "createdAt", "archivedAt"]) {
      expect(updateCustomerSchema.safeParse({ [field]: "x" }).success).toBe(false);
    }
  });

  it("lets optional fields be cleared with null or blank", () => {
    const parsed = updateCustomerSchema.parse({ company: null, phone: "" });
    expect(parsed).toEqual({ company: null, phone: null });
  });
});

describe("listCustomersQuerySchema", () => {
  it("applies defaults and parses comma separated filters", () => {
    const parsed = listCustomersQuerySchema.parse({
      status: "ACTIVE,INACTIVE",
      includeArchived: "true",
    });
    expect(parsed).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: "createdAt",
      order: "desc",
      status: ["ACTIVE", "INACTIVE"],
      includeArchived: true,
    });
  });

  it.each([
    { page: "0" },
    { pageSize: "101" },
    { sort: "email" },
    { order: "sideways" },
    { status: "NOPE" },
    { tagIds: "not-a-uuid" },
    { createdFrom: "yesterday" },
  ])("rejects %j", (input) => {
    expect(listCustomersQuerySchema.safeParse(input).success).toBe(false);
  });

  it("ignores unknown parameters such as organizationId", () => {
    const parsed = listCustomersQuerySchema.parse({ organizationId: crypto.randomUUID() });
    expect("organizationId" in parsed).toBe(false);
  });
});

describe("tags and notes", () => {
  it("accepts a tag id or a name, not both or neither", () => {
    expect(assignTagSchema.safeParse({ tagId: crypto.randomUUID() }).success).toBe(true);
    expect(assignTagSchema.parse({ name: "  VIP  " })).toEqual({ name: "VIP" });
    expect(assignTagSchema.safeParse({}).success).toBe(false);
    expect(assignTagSchema.safeParse({ tagId: crypto.randomUUID(), name: "x" }).success).toBe(
      false,
    );
  });

  it("rejects empty and oversized notes and any author override", () => {
    expect(createNoteSchema.safeParse({ content: "   " }).success).toBe(false);
    expect(createNoteSchema.safeParse({ content: "x".repeat(5001) }).success).toBe(false);
    expect(
      createNoteSchema.safeParse({ content: "ok", authorId: crypto.randomUUID() }).success,
    ).toBe(false);
  });
});
