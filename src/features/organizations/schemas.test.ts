import { describe, expect, it } from "vitest";
import {
  addMemberSchema,
  changeRoleSchema,
  createOrganizationSchema,
  transferOwnershipSchema,
} from "./schemas";

describe("createOrganizationSchema", () => {
  it("trims the name and accepts an optional valid slug", () => {
    const parsed = createOrganizationSchema.parse({ name: "  Acme Inc ", slug: "acme-inc" });
    expect(parsed).toEqual({ name: "Acme Inc", slug: "acme-inc" });
  });

  it.each([
    [{ name: "" }],
    [{ name: "   " }],
    [{}],
    [{ name: "x".repeat(101) }],
    [{ name: "Acme", slug: "Not Valid" }],
    [{ name: "Acme", slug: "-leading" }],
    [{ name: "Acme", slug: "a" }],
  ])("rejects %j", (input) => {
    expect(createOrganizationSchema.safeParse(input).success).toBe(false);
  });
});

describe("member schemas", () => {
  it("lowercases emails and defaults the role to MEMBER", () => {
    expect(addMemberSchema.parse({ email: "Bob@Example.com" })).toEqual({
      email: "bob@example.com",
      role: "MEMBER",
    });
  });

  it("rejects OWNER, unknown roles and malformed emails", () => {
    expect(changeRoleSchema.safeParse({ role: "OWNER" }).success).toBe(false);
    expect(changeRoleSchema.safeParse({ role: "SUPERUSER" }).success).toBe(false);
    expect(addMemberSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
  });

  it("requires a uuid for ownership transfer", () => {
    expect(transferOwnershipSchema.safeParse({ userId: "nope" }).success).toBe(false);
  });
});
