import { afterAll, beforeEach, expect, it, vi } from "vitest";
import {
  DELETE as archiveRoute,
  GET as getCustomerRoute,
  PATCH as updateRoute,
} from "@/app/api/customers/[customerId]/route";
import { GET as activitiesRoute } from "@/app/api/customers/[customerId]/activities/route";
import {
  GET as listNotesRoute,
  POST as addNoteRoute,
} from "@/app/api/customers/[customerId]/notes/route";
import {
  GET as listCustomerTagsRoute,
  POST as assignTagRoute,
} from "@/app/api/customers/[customerId]/tags/route";
import { DELETE as removeTagRoute } from "@/app/api/customers/[customerId]/tags/[tagId]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/customers/route";
import { DELETE as deleteTagRoute, PATCH as renameTagRoute } from "@/app/api/tags/[tagId]/route";
import { GET as listTagsRoute } from "@/app/api/tags/route";
import { requireOrganizationContext } from "@/server/auth/context";
import { call } from "../helpers/api";
import { addTestMember, describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { session } from "../helpers/mocks";
import {
  as,
  activitiesOf,
  seedCustomer,
  seedTag,
  seedTagLink,
  setupTenants,
} from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("customer tenant isolation", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let customerA: Awaited<ReturnType<typeof seedCustomer>>;
  let customerB: Awaited<ReturnType<typeof seedCustomer>>;
  let tagA: Awaited<ReturnType<typeof seedTag>>;
  let tagB: Awaited<ReturnType<typeof seedTag>>;

  const id = (customerId: string, extra: Record<string, string> = {}) => ({ customerId, ...extra });
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
    customerA = await seedCustomer(t.orgA.id, { firstName: "Alice", email: "alice@a.test" });
    customerB = await seedCustomer(t.orgB.id, { firstName: "Bob", email: "bob@b.test" });
    tagA = await seedTag(t.orgA.id, "VIP");
    tagB = await seedTag(t.orgB.id, "Secret");
    await seedTagLink(t.orgB.id, customerB.id, tagB.id);
    // Use the highest-privilege user of org A so only tenancy, not RBAC, can cause a denial.
    as(t.ownerA);
  });
  afterAll(disconnectDatabase);

  it("makes another organization's customer indistinguishable from a nonexistent one", async () => {
    const foreign = await call(getCustomerRoute, { params: id(customerB.id) });
    const missing = await call(getCustomerRoute, { params: id(crypto.randomUUID()) });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(foreign.body)).not.toContain("Bob");
  });

  it("blocks reading, updating and archiving another organization's customer without side effects", async () => {
    const read = await call(getCustomerRoute, { params: id(customerB.id) });
    const update = await call(updateRoute, {
      method: "PATCH",
      params: id(customerB.id),
      body: { firstName: "Hacked" },
    });
    const archive = await call(archiveRoute, { method: "DELETE", params: id(customerB.id) });
    expect([read.status, update.status, archive.status]).toEqual([404, 404, 404]);

    const row = await (await db()).customer.findUniqueOrThrow({ where: { id: customerB.id } });
    expect(row).toMatchObject({ firstName: "Bob", status: "ACTIVE", archivedAt: null });
    expect(await activitiesOf(customerB.id)).toHaveLength(0);
  });

  it("blocks reading another organization's timeline, notes and tags", async () => {
    const params = id(customerB.id);
    expect((await call(activitiesRoute, { params })).status).toBe(404);
    expect((await call(listNotesRoute, { params })).status).toBe(404);
    expect((await call(listCustomerTagsRoute, { params })).status).toBe(404);
  });

  it("blocks adding a note to another organization's customer", async () => {
    const res = await call(addNoteRoute, {
      method: "POST",
      params: id(customerB.id),
      body: { content: "sneaky" },
    });
    expect(res.status).toBe(404);
    expect(await (await db()).customerNote.count()).toBe(0);
    expect(await activitiesOf(customerB.id)).toHaveLength(0);
  });

  it("blocks assigning another organization's tag to this organization's customer", async () => {
    const res = await call(assignTagRoute, {
      method: "POST",
      params: id(customerA.id),
      body: { tagId: tagB.id },
    });
    expect(res.status).toBe(404);
    expect(await (await db()).customerTag.count({ where: { customerId: customerA.id } })).toBe(0);
    expect(await activitiesOf(customerA.id)).toHaveLength(0);
  });

  it("blocks tagging another organization's customer, by id or by name", async () => {
    const byId = await call(assignTagRoute, {
      method: "POST",
      params: id(customerB.id),
      body: { tagId: tagA.id },
    });
    const byName = await call(assignTagRoute, {
      method: "POST",
      params: id(customerB.id),
      body: { name: "Brand New" },
    });
    expect([byId.status, byName.status]).toEqual([404, 404]);
    // The failed by-name call must not leave a stray tag behind in either tenant.
    expect(await (await db()).tag.count({ where: { normalizedName: "brand new" } })).toBe(0);
  });

  it("blocks removing, renaming and deleting another organization's tags", async () => {
    const remove = await call(removeTagRoute, {
      method: "DELETE",
      params: id(customerB.id, { tagId: tagB.id }),
    });
    const rename = await call(renameTagRoute, {
      method: "PATCH",
      params: { tagId: tagB.id },
      body: { name: "Renamed" },
    });
    const del = await call(deleteTagRoute, { method: "DELETE", params: { tagId: tagB.id } });
    expect([remove.status, rename.status, del.status]).toEqual([404, 404, 404]);
    const tag = await (await db()).tag.findUniqueOrThrow({ where: { id: tagB.id } });
    expect(tag.name).toBe("Secret");
    expect(await (await db()).customerTag.count({ where: { tagId: tagB.id } })).toBe(1);
  });

  it("lists, searches and filters only the caller's organization", async () => {
    const all = await call(listRoute);
    expect(all.body.items.map((c: { id: string }) => c.id)).toEqual([customerA.id]);

    const search = await call(listRoute, { query: { q: "bob" } });
    expect(search.body.total).toBe(0);
    const byTag = await call(listRoute, { query: { tagIds: tagB.id } });
    expect(byTag.body.total).toBe(0);

    const tags = await call(listTagsRoute);
    expect(tags.body.tags.map((tag: { id: string }) => tag.id)).toEqual([tagA.id]);
  });

  it("ignores an organizationId smuggled in the query string or body", async () => {
    const list = await call(listRoute, { query: { organizationId: t.orgB.id } });
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([customerA.id]);

    const created = await call(createRoute, {
      method: "POST",
      body: { firstName: "Mallory", organizationId: t.orgB.id },
    });
    expect(created.status).toBe(400);
    expect(await (await db()).customer.count({ where: { firstName: "Mallory" } })).toBe(0);
  });

  it("does not let a forged active-organization preference grant another tenant's data", async () => {
    session.activeOrganizationId = t.orgB.id; // ownerA is not a member of org B
    expect((await requireOrganizationContext()).organization.id).toBe(t.orgA.id);
    expect((await call(getCustomerRoute, { params: id(customerB.id) })).status).toBe(404);

    const created = await call(createRoute, { method: "POST", body: { firstName: "Landed" } });
    const row = await (
      await db()
    ).customer.findUniqueOrThrow({
      where: { id: created.body.customer.id },
    });
    expect(row.organizationId).toBe(t.orgA.id);
  });

  it("scopes a multi-organization user to the organization they have selected", async () => {
    await addTestMember(t.orgB.id, t.ownerA.id, "MEMBER");

    session.activeOrganizationId = t.orgA.id;
    expect((await call(getCustomerRoute, { params: id(customerB.id) })).status).toBe(404);
    expect((await call(getCustomerRoute, { params: id(customerA.id) })).status).toBe(200);

    session.activeOrganizationId = t.orgB.id;
    expect((await call(getCustomerRoute, { params: id(customerB.id) })).status).toBe(200);
    expect((await call(getCustomerRoute, { params: id(customerA.id) })).status).toBe(404);
    // Role is per organization: OWNER in A, only MEMBER in B.
    expect((await call(archiveRoute, { method: "DELETE", params: id(customerB.id) })).status).toBe(
      403,
    );
  });
});
