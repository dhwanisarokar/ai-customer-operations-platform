import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { GET as getOrganization } from "@/app/api/organizations/[organizationId]/route";
import {
  GET as listMembersRoute,
  POST as addMemberRoute,
} from "@/app/api/organizations/[organizationId]/members/route";
import {
  DELETE as removeMemberRoute,
  PATCH as changeRoleRoute,
} from "@/app/api/organizations/[organizationId]/members/[userId]/route";
import { POST as transferRoute } from "@/app/api/organizations/[organizationId]/ownership-transfer/route";
import { requireOrganizationContext } from "@/server/auth/context";
import { call } from "../helpers/api";
import {
  addTestMember,
  createTestOrganization,
  createTestUser,
  describeDb,
  disconnectDatabase,
  resetDatabase,
} from "../helpers/db";
import { resetSession, session, signInAs } from "../helpers/mocks";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("tenant isolation", () => {
  let orgA: { id: string };
  let orgB: { id: string };
  let userA: { id: string; authProviderId: string };
  let userB: { id: string; authProviderId: string };

  beforeEach(async () => {
    await resetDatabase();
    resetSession();
    userA = await createTestUser("usera");
    userB = await createTestUser("userb");
    orgA = await createTestOrganization(userA, "Org A");
    orgB = await createTestOrganization(userB, "Org B");
    signInAs(userA.authProviderId);
  });
  afterAll(disconnectDatabase);

  it("lets a member read their own organization", async () => {
    const res = await call(getOrganization, { params: { organizationId: orgA.id } });
    expect(res.status).toBe(200);
    expect(res.body.organization.id).toBe(orgA.id);
    expect(res.body.role).toBe("OWNER");
  });

  it("denies user A access to organization B without revealing it exists", async () => {
    const foreign = await call(getOrganization, { params: { organizationId: orgB.id } });
    const missing = await call(getOrganization, {
      params: { organizationId: crypto.randomUUID() },
    });
    expect(foreign.status).toBe(404);
    // Indistinguishable from an organization that does not exist.
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(foreign.body)).not.toContain("Org B");
  });

  it("denies every member endpoint of organization B to user A", async () => {
    const params = { organizationId: orgB.id };
    expect((await call(listMembersRoute, { params })).status).toBe(404);
    expect(
      (await call(addMemberRoute, { method: "POST", params, body: { email: "usera@example.com" } }))
        .status,
    ).toBe(404);
    expect(
      (
        await call(changeRoleRoute, {
          method: "PATCH",
          params: { ...params, userId: userB.id },
          body: { role: "MEMBER" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(removeMemberRoute, { method: "DELETE", params: { ...params, userId: userB.id } }))
        .status,
    ).toBe(404);
    expect(
      (await call(transferRoute, { method: "POST", params, body: { userId: userA.id } })).status,
    ).toBe(404);

    // Nothing changed in organization B.
    const { getDb } = await import("@/db/client");
    const memberships = await getDb().membership.findMany({ where: { organizationId: orgB.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ userId: userB.id, role: "OWNER" });
  });

  it("treats a malformed organization id as not found", async () => {
    expect((await call(getOrganization, { params: { organizationId: "not-a-uuid" } })).status).toBe(
      404,
    );
  });

  it("does not let a forged active-organization preference grant access", async () => {
    session.activeOrganizationId = orgB.id; // attacker-controlled cookie value
    const ctx = await requireOrganizationContext();
    expect(ctx.organization.id).toBe(orgA.id);
  });

  it("resolves the active organization only among the user's memberships", async () => {
    const second = await createTestOrganization(userA, "Second");
    session.activeOrganizationId = second.id;
    expect((await requireOrganizationContext()).organization.id).toBe(second.id);
  });

  it("keeps roles per organization: admin in one tenant has no rights in another", async () => {
    await addTestMember(orgB.id, userA.id, "MEMBER");
    const ctxB = await requireOrganizationContext(orgB.id);
    expect(ctxB.membership.role).toBe("MEMBER");
    expect(ctxB.can("manage_members")).toBe(false);
    const ctxA = await requireOrganizationContext(orgA.id);
    expect(ctxA.can("manage_members")).toBe(true);
  });

  it("fails with 404 when the user has no organization at all", async () => {
    const loner = await createTestUser("loner");
    signInAs(loner.authProviderId);
    await expect(requireOrganizationContext()).rejects.toMatchObject({ status: 404 });
  });
});
