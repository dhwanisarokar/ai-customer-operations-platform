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

describe("customer permissions", () => {
  const memberCan = [
    "view_customers",
    "create_customers",
    "update_customers",
    "add_customer_notes",
    "tag_customers",
  ] as const;
  const adminOnly = ["archive_customers", "manage_tags"] as const;

  it("lets every role do day-to-day customer work", () => {
    for (const role of [Role.MEMBER, Role.ADMIN, Role.OWNER]) {
      for (const permission of memberCan) expect(hasPermission(role, permission)).toBe(true);
    }
  });

  it("reserves archiving customers and managing shared tags for ADMIN and OWNER", () => {
    for (const permission of adminOnly) {
      expect(hasPermission(Role.MEMBER, permission)).toBe(false);
      expect(hasPermission(Role.ADMIN, permission)).toBe(true);
      expect(hasPermission(Role.OWNER, permission)).toBe(true);
    }
  });
});

describe("conversation permissions", () => {
  const memberCan = [
    "view_conversations",
    "create_conversations",
    "update_conversations",
    "send_messages",
  ] as const;

  it("lets every role work the inbox", () => {
    for (const role of [Role.MEMBER, Role.ADMIN, Role.OWNER]) {
      for (const permission of memberCan) expect(hasPermission(role, permission)).toBe(true);
    }
  });

  it("reserves assigning conversations to others for ADMIN and OWNER", () => {
    expect(hasPermission(Role.MEMBER, "assign_conversations")).toBe(false);
    expect(hasPermission(Role.ADMIN, "assign_conversations")).toBe(true);
    expect(hasPermission(Role.OWNER, "assign_conversations")).toBe(true);
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

describe("automation permissions", () => {
  it("lets every role view automations", () => {
    for (const role of [Role.MEMBER, Role.ADMIN, Role.OWNER]) {
      expect(hasPermission(role, "view_automations")).toBe(true);
    }
  });

  it("reserves creating, changing, deleting and testing automations for ADMIN and OWNER", () => {
    for (const permission of [
      "create_automations",
      "update_automations",
      "delete_automations",
      "execute_automations",
    ] as const) {
      expect(hasPermission(Role.MEMBER, permission)).toBe(false);
      expect(hasPermission(Role.ADMIN, permission)).toBe(true);
      expect(hasPermission(Role.OWNER, permission)).toBe(true);
    }
  });
});
