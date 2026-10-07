import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DELETE as archiveRoute,
  GET as getCustomerRoute,
  PATCH as updateRoute,
} from "@/app/api/customers/[customerId]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/customers/route";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, activitiesOf, seedCustomer, setupTenants } from "../helpers/tenants";
import { signOut } from "../helpers/mocks";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("customers", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  const id = (customerId: string) => ({ customerId });

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
    as(t.memberA);
  });
  afterAll(disconnectDatabase);

  async function create(body: Record<string, unknown>) {
    return call(createRoute, { method: "POST", body });
  }
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  describe("creation", () => {
    it("creates a normalized customer in the caller's organization with a CREATED activity", async () => {
      const res = await create({
        firstName: "  Ada ",
        lastName: "Lovelace",
        email: "  ADA@Example.COM ",
        phone: "+1 (555) 010-9999",
        company: "Analytical Engines",
        source: "web",
      });
      expect(res.status).toBe(201);
      expect(res.body.customer).toMatchObject({
        firstName: "Ada",
        email: "ada@example.com",
        phone: "+15550109999",
        status: "ACTIVE",
        archivedAt: null,
      });
      expect(res.body.customer.organizationId).toBeUndefined();

      const row = await (
        await db()
      ).customer.findUniqueOrThrow({ where: { id: res.body.customer.id } });
      expect(row.organizationId).toBe(t.orgA.id);

      const activities = await activitiesOf(row.id);
      expect(activities).toHaveLength(1);
      expect(activities[0]).toMatchObject({
        type: "CUSTOMER_CREATED",
        actorType: "USER",
        actorId: t.memberA.id,
        organizationId: t.orgA.id,
      });
      expect(row.lastActivityAt.getTime()).toBe(activities[0].createdAt.getTime());
    });

    it("rejects the same email in a different case within an organization, but allows it in another", async () => {
      expect((await create({ firstName: "A", email: "dup@example.com" })).status).toBe(201);
      const again = await create({ firstName: "B", email: "DUP@example.com" });
      expect(again.status).toBe(409);
      expect(again.body.error.message).toMatch(/email/i);

      as(t.ownerB);
      expect((await create({ firstName: "C", email: "dup@example.com" })).status).toBe(201);
    });

    it("rejects a duplicate external id with 409", async () => {
      await create({ firstName: "A", externalId: "crm-1" });
      const res = await create({ firstName: "B", externalId: "crm-1" });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/external id/i);
    });

    it("rolls back the customer when the activity cannot be written", async () => {
      const spy = vi
        .spyOn(customerActivitiesRepository, "record")
        .mockRejectedValueOnce(new Error("activity insert failed"));
      const res = await create({ firstName: "Ghost", email: "ghost@example.com" });
      spy.mockRestore();
      expect(res.status).toBe(500);
      expect(await (await db()).customer.count()).toBe(0);
    });

    it.each([
      ["invalid email", { firstName: "A", email: "not-an-email" }],
      ["missing first name", { lastName: "X" }],
      ["blank first name", { firstName: "  " }],
      ["invalid status", { firstName: "A", status: "VIP" }],
      ["ARCHIVED status", { firstName: "A", status: "ARCHIVED" }],
      ["invalid phone", { firstName: "A", phone: "hello" }],
      ["organizationId in body", { firstName: "A", organizationId: crypto.randomUUID() }],
      ["non-object payload", ["x"]],
    ])("returns 400 for %s and creates nothing", async (_label, body) => {
      const res = await create(body as Record<string, unknown>);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(await (await db()).customer.count()).toBe(0);
    });

    it("returns 400 for malformed JSON", async () => {
      expect((await call(createRoute, { method: "POST", rawBody: "{nope" })).status).toBe(400);
    });

    it("rejects unauthenticated requests with 401", async () => {
      signOut();
      expect((await create({ firstName: "A" })).status).toBe(401);
      expect((await call(listRoute)).status).toBe(401);
    });
  });

  describe("Customer 360", () => {
    it("returns the customer with tags, recent activities, notes and counts", async () => {
      const customer = await seedCustomer(t.orgA.id, {
        firstName: "Grace",
        email: "g@example.com",
      });
      const res = await call(getCustomerRoute, { params: id(customer.id) });
      expect(res.status).toBe(200);
      expect(res.body.customer).toMatchObject({ id: customer.id, firstName: "Grace" });
      expect(res.body).toMatchObject({
        tags: [],
        recentActivities: [],
        notes: [],
        counts: { activities: 0, notes: 0 },
      });
      expect(res.body.customer.organizationId).toBeUndefined();
    });

    it("returns 404 for unknown and malformed ids", async () => {
      expect((await call(getCustomerRoute, { params: id(crypto.randomUUID()) })).status).toBe(404);
      expect((await call(getCustomerRoute, { params: id("nope") })).status).toBe(404);
    });
  });

  describe("update", () => {
    it("updates fields and records exactly the changed fields in the timeline", async () => {
      const customer = await seedCustomer(t.orgA.id, { firstName: "Ada", company: "Old Co" });
      const res = await call(updateRoute, {
        method: "PATCH",
        params: id(customer.id),
        body: { company: "New Co", firstName: "Ada", email: "Ada@Example.com" },
      });
      expect(res.status).toBe(200);
      expect(res.body.customer).toMatchObject({ company: "New Co", email: "ada@example.com" });

      const [activity] = await activitiesOf(customer.id);
      expect(activity.type).toBe("CUSTOMER_UPDATED");
      expect(activity.metadata).toEqual({
        changes: {
          company: { from: "Old Co", to: "New Co" },
          email: { from: null, to: "ada@example.com" },
        },
      });
      const row = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(row.updatedAt.getTime()).toBeGreaterThan(customer.updatedAt.getTime());
    });

    it("clears optional fields and does not write an activity for a no-op update", async () => {
      const customer = await seedCustomer(t.orgA.id, { company: "Acme" });
      const noop = await call(updateRoute, {
        method: "PATCH",
        params: id(customer.id),
        body: { company: "Acme" },
      });
      expect(noop.status).toBe(200);
      expect(await activitiesOf(customer.id)).toHaveLength(0);

      const cleared = await call(updateRoute, {
        method: "PATCH",
        params: id(customer.id),
        body: { company: "" },
      });
      expect(cleared.body.customer.company).toBeNull();
      expect(await activitiesOf(customer.id)).toHaveLength(1);
    });

    it.each([
      ["organizationId", { organizationId: crypto.randomUUID() }],
      ["id", { id: crypto.randomUUID() }],
      ["createdAt", { createdAt: "2020-01-01T00:00:00.000Z" }],
      ["archivedAt", { archivedAt: null }],
      ["ARCHIVED status", { status: "ARCHIVED" }],
      ["empty body", {}],
      ["invalid email", { email: "bad" }],
    ])("rejects %s with 400 and changes nothing", async (_label, body) => {
      const customer = await seedCustomer(t.orgA.id, { firstName: "Keep" });
      const res = await call(updateRoute, { method: "PATCH", params: id(customer.id), body });
      expect(res.status).toBe(400);
      const row = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(row).toMatchObject({ firstName: "Keep", organizationId: t.orgA.id });
      expect(await activitiesOf(customer.id)).toHaveLength(0);
    });

    it("returns 409 when the new email belongs to another customer", async () => {
      await seedCustomer(t.orgA.id, { email: "taken@example.com" });
      const other = await seedCustomer(t.orgA.id, { email: "free@example.com" });
      const res = await call(updateRoute, {
        method: "PATCH",
        params: id(other.id),
        body: { email: "TAKEN@example.com" },
      });
      expect(res.status).toBe(409);
    });

    it("lets a customer keep its own email when saving other fields", async () => {
      const customer = await seedCustomer(t.orgA.id, { email: "me@example.com" });
      const res = await call(updateRoute, {
        method: "PATCH",
        params: id(customer.id),
        body: { email: "ME@example.com", company: "Acme" },
      });
      expect(res.status).toBe(200);
    });
  });

  describe("archive", () => {
    it("lets an ADMIN archive: soft-deletes, keeps the row, writes one activity", async () => {
      const customer = await seedCustomer(t.orgA.id, { firstName: "Old" });
      as(t.adminA);
      const first = await call(archiveRoute, { method: "DELETE", params: id(customer.id) });
      const second = await call(archiveRoute, { method: "DELETE", params: id(customer.id) });
      expect([first.status, second.status]).toEqual([204, 204]);

      const row = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(row.status).toBe("ARCHIVED");
      expect(row.archivedAt).toBeInstanceOf(Date);
      const activities = await activitiesOf(customer.id);
      expect(activities.map((a) => a.type)).toEqual(["CUSTOMER_ARCHIVED"]);
    });

    it("denies a MEMBER with 403 and leaves the customer untouched", async () => {
      const customer = await seedCustomer(t.orgA.id);
      const res = await call(archiveRoute, { method: "DELETE", params: id(customer.id) });
      expect(res.status).toBe(403);
      const row = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(row.status).toBe("ACTIVE");
    });

    it("hides archived customers from the default list but not from detail or filters", async () => {
      const active = await seedCustomer(t.orgA.id, { firstName: "Active" });
      const archived = await seedCustomer(t.orgA.id, { firstName: "Gone" });
      as(t.adminA);
      await call(archiveRoute, { method: "DELETE", params: id(archived.id) });

      const defaultList = await listWith({});
      expect(defaultList.items.map((c: { id: string }) => c.id)).toEqual([active.id]);
      const withArchived = await listWith({ includeArchived: "true" });
      expect(withArchived.total).toBe(2);
      const onlyArchived = await listWith({ status: "ARCHIVED" });
      expect(onlyArchived.items.map((c: { id: string }) => c.id)).toEqual([archived.id]);

      const detail = await call(getCustomerRoute, { params: id(archived.id) });
      expect(detail.status).toBe(200);
      expect(detail.body.customer.status).toBe("ARCHIVED");
    });

    it("restores an archived customer when an active status is set", async () => {
      const customer = await seedCustomer(t.orgA.id);
      as(t.adminA);
      await call(archiveRoute, { method: "DELETE", params: id(customer.id) });
      const res = await call(updateRoute, {
        method: "PATCH",
        params: id(customer.id),
        body: { status: "ACTIVE" },
      });
      expect(res.body.customer).toMatchObject({ status: "ACTIVE", archivedAt: null });
    });
  });

  async function listWith(query: Record<string, string>) {
    return (await call(listRoute, { query })).body;
  }
});
