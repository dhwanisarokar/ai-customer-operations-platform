import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { GET as getMe } from "@/app/api/me/route";
import { PUT as setActiveOrganization } from "@/app/api/me/active-organization/route";
import {
  GET as listOrganizations,
  POST as createOrganizationRoute,
} from "@/app/api/organizations/route";
import { GET as getOrganization } from "@/app/api/organizations/[organizationId]/route";
import { call } from "../helpers/api";
import {
  createTestOrganization,
  createTestUser,
  describeDb,
  disconnectDatabase,
  resetDatabase,
} from "../helpers/db";
import { resetSession, session, signInAs, signOut } from "../helpers/mocks";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("authentication", () => {
  beforeEach(async () => {
    await resetDatabase();
    resetSession();
  });
  afterAll(disconnectDatabase);

  it("rejects unauthenticated requests with 401 on every protected endpoint", async () => {
    signOut();
    expect((await call(getMe)).status).toBe(401);
    expect((await call(listOrganizations)).status).toBe(401);
    expect(
      (await call(createOrganizationRoute, { method: "POST", body: { name: "X" } })).status,
    ).toBe(401);
    expect(
      (await call(getOrganization, { params: { organizationId: crypto.randomUUID() } })).status,
    ).toBe(401);
  });

  it("accepts an authenticated request and returns only safe user fields", async () => {
    const alice = await createTestUser("alice");
    signInAs(alice.authProviderId);
    const res = await call(getMe);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: alice.id, email: "alice@example.com", name: "alice" });
    expect(res.body.user.authProviderId).toBeUndefined();
  });

  it("provisions a local user on first authenticated request, once", async () => {
    session.profiles.set("clerk_new", {
      email: "new@example.com",
      emailVerified: true,
      name: "New Person",
    });
    signInAs("clerk_new");
    const first = await call(getMe);
    const second = await call(getMe);
    expect(first.status).toBe(200);
    expect(second.body.user.id).toBe(first.body.user.id);
    const { getDb } = await import("@/db/client");
    expect(await getDb().user.count()).toBe(1);
  });

  it("refuses accounts that have no email address", async () => {
    session.profiles.set("clerk_noemail", null);
    signInAs("clerk_noemail");
    expect((await call(getMe)).status).toBe(403);
  });

  it("rejects a second identity that claims an existing email", async () => {
    await createTestUser("dup");
    session.profiles.set("clerk_other", {
      email: "dup@example.com",
      emailVerified: true,
      name: null,
    });
    signInAs("clerk_other");
    expect((await call(getMe)).status).toBe(409);
  });
});

describeDb("organization creation", () => {
  beforeEach(async () => {
    await resetDatabase();
    resetSession();
  });
  afterAll(disconnectDatabase);

  it("creates the organization, persists it, and makes the creator OWNER", async () => {
    const alice = await createTestUser("alice");
    signInAs(alice.authProviderId);

    const res = await call(createOrganizationRoute, {
      method: "POST",
      body: { name: "  Acme Inc " },
    });
    expect(res.status).toBe(201);
    expect(res.body.organization).toMatchObject({
      name: "Acme Inc",
      slug: "acme-inc",
      role: "OWNER",
    });

    const { getDb } = await import("@/db/client");
    const memberships = await getDb().membership.findMany({ include: { organization: true } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]).toMatchObject({ userId: alice.id, role: "OWNER" });
    expect(memberships[0].organization.id).toBe(res.body.organization.id);
    expect(session.activeOrganizationId).toBe(res.body.organization.id);
  });

  it("generates a unique slug when the name collides", async () => {
    const alice = await createTestUser("alice");
    const bob = await createTestUser("bob");
    signInAs(alice.authProviderId);
    await call(createOrganizationRoute, { method: "POST", body: { name: "Acme" } });
    signInAs(bob.authProviderId);
    const res = await call(createOrganizationRoute, { method: "POST", body: { name: "Acme" } });
    expect(res.status).toBe(201);
    expect(res.body.organization.slug).toMatch(/^acme-[0-9a-f]{4}$/);
  });

  it("rejects an explicitly requested slug that is taken with 409", async () => {
    const alice = await createTestUser("alice");
    signInAs(alice.authProviderId);
    await call(createOrganizationRoute, { method: "POST", body: { name: "Acme", slug: "acme" } });
    const res = await call(createOrganizationRoute, {
      method: "POST",
      body: { name: "Other", slug: "acme" },
    });
    expect(res.status).toBe(409);
  });

  it("never leaves a partial organization when the owner membership cannot be created", async () => {
    const { organizationsRepository } = await import("@/server/repositories/organizations");
    await expect(
      organizationsRepository.createWithOwner({
        name: "Ghost",
        slug: "ghost",
        ownerUserId: crypto.randomUUID(), // violates the memberships.userId foreign key
      }),
    ).rejects.toThrow();
    const { getDb } = await import("@/db/client");
    expect(await getDb().organization.count()).toBe(0);
  });

  it.each([
    ["empty name", { name: "" }],
    ["blank name", { name: "   " }],
    ["missing name", {}],
    ["invalid slug", { name: "Acme", slug: "Not A Slug!" }],
  ])("returns 400 with field details for %s", async (_label, body) => {
    const alice = await createTestUser("alice");
    signInAs(alice.authProviderId);
    const res = await call(createOrganizationRoute, { method: "POST", body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
    expect(res.body.error.details.length).toBeGreaterThan(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const alice = await createTestUser("alice");
    signInAs(alice.authProviderId);
    const res = await call(createOrganizationRoute, { method: "POST", rawBody: "{oops" });
    expect(res.status).toBe(400);
  });

  it("lists only the caller's organizations, with their roles", async () => {
    const alice = await createTestUser("alice");
    const bob = await createTestUser("bob");
    await createTestOrganization(alice, "Alpha");
    await createTestOrganization(bob, "Beta");
    signInAs(alice.authProviderId);
    const res = await call(listOrganizations);
    expect(res.body.organizations).toHaveLength(1);
    expect(res.body.organizations[0]).toMatchObject({ name: "Alpha", role: "OWNER" });
  });

  it("switches the active organization only to one the user belongs to", async () => {
    const alice = await createTestUser("alice");
    const bob = await createTestUser("bob");
    const alpha = await createTestOrganization(alice, "Alpha");
    const beta = await createTestOrganization(bob, "Beta");
    signInAs(alice.authProviderId);

    const ok = await call(setActiveOrganization, {
      method: "PUT",
      body: { organizationId: alpha.id },
    });
    expect(ok.status).toBe(200);
    expect(session.activeOrganizationId).toBe(alpha.id);

    session.activeOrganizationId = null;
    const denied = await call(setActiveOrganization, {
      method: "PUT",
      body: { organizationId: beta.id },
    });
    expect(denied.status).toBe(404);
    expect(session.activeOrganizationId).toBeNull();
  });
});
