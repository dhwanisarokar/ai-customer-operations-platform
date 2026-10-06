import { describe, expect, it } from "vitest";
import { Role } from "@/generated/prisma/enums";
import { PERMISSIONS, canAssignRole, hasPermission, outranks } from "./permissions";

describe("role permissions", () => {
  it("grants the owner every permission", () => {
    for (const permission of PERMISSIONS) expect(hasPermission(Role.OWNER, permission)).toBe(true);
  });

  it("lets admins manage members but not the organization or ownership", () => {
    expect(hasPermission(Role.ADMIN, "manage_members")).toBe(true);
    expect(hasPermission(Role.ADMIN, "manage_organization")).toBe(false);
    expect(hasPermission(Role.ADMIN, "transfer_ownership")).toBe(false);
  });

  it("limits members to read access", () => {
    expect(hasPermission(Role.MEMBER, "view_organization")).toBe(true);
    expect(hasPermission(Role.MEMBER, "view_members")).toBe(true);
    expect(hasPermission(Role.MEMBER, "manage_members")).toBe(false);
  });
});

describe("role hierarchy", () => {
  it("only lets a role act on strictly lower roles", () => {
    expect(outranks(Role.OWNER, Role.ADMIN)).toBe(true);
    expect(outranks(Role.ADMIN, Role.MEMBER)).toBe(true);
    expect(outranks(Role.ADMIN, Role.ADMIN)).toBe(false);
    expect(outranks(Role.MEMBER, Role.OWNER)).toBe(false);
  });

  it("never allows assigning OWNER directly and stops admins granting admin", () => {
    expect(canAssignRole(Role.OWNER, Role.OWNER)).toBe(false);
    expect(canAssignRole(Role.OWNER, Role.ADMIN)).toBe(true);
    expect(canAssignRole(Role.ADMIN, Role.ADMIN)).toBe(false);
    expect(canAssignRole(Role.ADMIN, Role.MEMBER)).toBe(true);
    expect(canAssignRole(Role.MEMBER, Role.MEMBER)).toBe(false);
  });
});
