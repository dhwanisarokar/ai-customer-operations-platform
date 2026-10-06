import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  GET as listMembersRoute,
  POST as addMemberRoute,
} from "@/app/api/organizations/[organizationId]/members/route";
import {
  DELETE as removeMemberRoute,
  PATCH as changeRoleRoute,
} from "@/app/api/organizations/[organizationId]/members/[userId]/route";
import { POST as transferRoute } from "@/app/api/organizations/[organizationId]/ownership-transfer/route";
import { call } from "../helpers/api";
import {
  addTestMember,
  createTestOrganization,
  createTestUser,
  describeDb,
  disconnectDatabase,
  resetDatabase,
} from "../helpers/db";
import { resetSession, signInAs } from "../helpers/mocks";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type U = { id: string; authProviderId: string };

describeDb("membership management and RBAC", () => {
  let org: { id: string };
  let owner: U, admin: U, otherAdmin: U, member: U, outsider: U;

  const params = (extra: Record<string, string> = {}) => ({ organizationId: org.id, ...extra });
  const as = (user: U) => signInAs(user.authProviderId);
  const roleOf = async (user: U) => {
    const { getDb } = await import("@/db/client");
    const m = await getDb().membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId: org.id } },
    });
    return m?.role ?? null;
  };

  beforeEach(async () => {
    await resetDatabase();
    resetSession();
    owner = await createTestUser("owner");
    admin = await createTestUser("admin");
    otherAdmin = await createTestUser("otheradmin");
    member = await createTestUser("member");
    outsider = await createTestUser("outsider");
    org = await createTestOrganization(owner, "Acme");
    await addTestMember(org.id, admin.id, "ADMIN");
    await addTestMember(org.id, otherAdmin.id, "ADMIN");
    await addTestMember(org.id, member.id, "MEMBER");
  });
  afterAll(disconnectDatabase);

  it("lists members for any member of the organization", async () => {
    as(member);
    const res = await call(listMembersRoute, { params: params() });
    expect(res.status).toBe(200);
    expect(res.body.members.map((m: { email: string }) => m.email).sort()).toEqual([
      "admin@example.com",
      "member@example.com",
      "otheradmin@example.com",
      "owner@example.com",
    ]);
  });

  it("denies a MEMBER every management action with 403", async () => {
    as(member);
    const add = await call(addMemberRoute, {
      method: "POST",
      params: params(),
      body: { email: "outsider@example.com" },
    });
    const role = await call(changeRoleRoute, {
      method: "PATCH",
      params: params({ userId: admin.id }),
      body: { role: "MEMBER" },
    });
    const remove = await call(removeMemberRoute, {
      method: "DELETE",
      params: params({ userId: admin.id }),
    });
    const transfer = await call(transferRoute, {
      method: "POST",
      params: params(),
      body: { userId: member.id },
    });
    expect([add.status, role.status, remove.status, transfer.status]).toEqual([403, 403, 403, 403]);
    expect(await roleOf(admin)).toBe("ADMIN");
    expect(await roleOf(outsider)).toBeNull();
  });
  it("denies an ADMIN the owner-only ownership transfer with 403", async () => {
    as(admin);
    const res = await call(transferRoute, {
      method: "POST",
      params: params(),
      body: { userId: admin.id },
    });
    expect(res.status).toBe(403);
    const toSomeoneElse = await call(transferRoute, {
      method: "POST",
      params: params(),
      body: { userId: member.id },
    });
    expect(toSomeoneElse.status).toBe(403);
    expect(await roleOf(owner)).toBe("OWNER");
  });

  it("lets an ADMIN add and remove plain members", async () => {
    as(admin);
    const add = await call(addMemberRoute, {
      method: "POST",
      params: params(),
      body: { email: "Outsider@Example.com" },
    });
    expect(add.status).toBe(201);
    expect(add.body.member).toMatchObject({ email: "outsider@example.com", role: "MEMBER" });
    const remove = await call(removeMemberRoute, {
      method: "DELETE",
      params: params({ userId: outsider.id }),
    });
    expect(remove.status).toBe(204);
    expect(await roleOf(outsider)).toBeNull();
  });

  it("stops an ADMIN from granting ADMIN, or touching other admins and the owner", async () => {
    as(admin);
    const grant = await call(addMemberRoute, {
      method: "POST",
      params: params(),
      body: { email: "outsider@example.com", role: "ADMIN" },
    });
    const promote = await call(changeRoleRoute, {
      method: "PATCH",
      params: params({ userId: member.id }),
      body: { role: "ADMIN" },
    });
    const demoteAdmin = await call(changeRoleRoute, {
      method: "PATCH",
      params: params({ userId: otherAdmin.id }),
      body: { role: "MEMBER" },
    });
    const removeAdmin = await call(removeMemberRoute, {
      method: "DELETE",
      params: params({ userId: otherAdmin.id }),
    });
    const removeOwner = await call(removeMemberRoute, {
      method: "DELETE",
      params: params({ userId: owner.id }),
    });
    expect([
      grant.status,
      promote.status,
      demoteAdmin.status,
      removeAdmin.status,
      removeOwner.status,
    ]).toEqual([403, 403, 403, 403, 403]);
    expect(await roleOf(member)).toBe("MEMBER");
    expect(await roleOf(otherAdmin)).toBe("ADMIN");
    expect(await roleOf(owner)).toBe("OWNER");
  });

  it("lets the OWNER change roles", async () => {
    as(owner);
    const res = await call(changeRoleRoute, {
      method: "PATCH",
      params: params({ userId: member.id }),
      body: { role: "ADMIN" },
    });
    expect(res.status).toBe(200);
    expect(await roleOf(member)).toBe("ADMIN");
  });

  it("rejects duplicate membership with 409 and keeps a single row", async () => {
    as(owner);
    const res = await call(addMemberRoute, {
      method: "POST",
      params: params(),
      body: { email: "member@example.com" },
    });
    expect(res.status).toBe(409);
    const { getDb } = await import("@/db/client");
    expect(
      await getDb().membership.count({ where: { userId: member.id, organizationId: org.id } }),
    ).toBe(1);
  });

  it("enforces uniqueness in the database itself, not only in the service", async () => {
    await expect(addTestMember(org.id, member.id, "ADMIN")).rejects.toMatchObject({
      code: "P2002",
    });
  });

  it("returns 404 when adding an email that has no account", async () => {
    as(owner);
    const res = await call(addMemberRoute, {
      method: "POST",
      params: params(),
      body: { email: "ghost@example.com" },
    });
    expect(res.status).toBe(404);
  });

  it.each([
    ["unknown role", { email: "outsider@example.com", role: "SUPERUSER" }],
    ["OWNER role", { email: "outsider@example.com", role: "OWNER" }],
    ["bad email", { email: "nope" }],
  ])("returns 400 for %s", async (_label, body) => {
    as(owner);
    const res = await call(addMemberRoute, { method: "POST", params: params(), body });
    expect(res.status).toBe(400);
  });

  it("returns 400 when changing a role to an invalid value", async () => {
    as(owner);
    const res = await call(changeRoleRoute, {
      method: "PATCH",
      params: params({ userId: member.id }),
      body: { role: "OWNER" },
    });
    expect(res.status).toBe(400);
  });

  it("protects the sole owner: cannot leave or be removed", async () => {
    as(owner);
    const leave = await call(removeMemberRoute, {
      method: "DELETE",
      params: params({ userId: owner.id }),
    });
    expect(leave.status).toBe(403);
    expect(await roleOf(owner)).toBe("OWNER");
  });

  it("lets a non-owner leave an organization", async () => {
    as(member);
    const res = await call(removeMemberRoute, {
      method: "DELETE",
      params: params({ userId: member.id }),
    });
    expect(res.status).toBe(204);
    expect(await roleOf(member)).toBeNull();
  });

  it("transfers ownership atomically: new owner, old owner demoted to ADMIN", async () => {
    as(owner);
    const res = await call(transferRoute, {
      method: "POST",
      params: params(),
      body: { userId: member.id },
    });
    expect(res.status).toBe(200);
    expect(await roleOf(member)).toBe("OWNER");
    expect(await roleOf(owner)).toBe("ADMIN");
    const { getDb } = await import("@/db/client");
    expect(
      await getDb().membership.count({ where: { organizationId: org.id, role: "OWNER" } }),
    ).toBe(1);
  });

  it("refuses to transfer ownership to a non-member and changes nothing", async () => {
    as(owner);
    const res = await call(transferRoute, {
      method: "POST",
      params: params(),
      body: { userId: outsider.id },
    });
    expect(res.status).toBe(404);
    expect(await roleOf(owner)).toBe("OWNER");
  });

  it("serializes concurrent transfers so only one succeeds", async () => {
    as(owner);
    const results = await Promise.all([
      call(transferRoute, { method: "POST", params: params(), body: { userId: member.id } }),
      call(transferRoute, { method: "POST", params: params(), body: { userId: admin.id } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const { getDb } = await import("@/db/client");
    expect(
      await getDb().membership.count({ where: { organizationId: org.id, role: "OWNER" } }),
    ).toBe(1);
  });
});
