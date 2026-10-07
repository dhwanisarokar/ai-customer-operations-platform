import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { GET as getCustomerRoute } from "@/app/api/customers/[customerId]/route";
import { DELETE as deleteTagRoute, PATCH as renameTagRoute } from "@/app/api/tags/[tagId]/route";
import { GET as listTagsRoute, POST as createTagRoute } from "@/app/api/tags/route";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
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

describeDb("tags, notes and the activity timeline", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let customer: Awaited<ReturnType<typeof seedCustomer>>;
  const cid = (extra: Record<string, string> = {}) => ({ customerId: customer.id, ...extra });
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
    customer = await seedCustomer(t.orgA.id, { firstName: "Ada" });
    as(t.memberA);
  });
  afterAll(disconnectDatabase);

  describe("tag catalogue", () => {
    it("creates tags (members may), normalizing whitespace", async () => {
      const res = await call(createTagRoute, { method: "POST", body: { name: "  High   Value " } });
      expect(res.status).toBe(201);
      expect(res.body.tag.name).toBe("High Value");
      const row = await (await db()).tag.findUniqueOrThrow({ where: { id: res.body.tag.id } });
      expect(row).toMatchObject({ organizationId: t.orgA.id, normalizedName: "high value" });
    });

    it("rejects duplicate names within an organization regardless of case", async () => {
      await call(createTagRoute, { method: "POST", body: { name: "VIP" } });
      const dup = await call(createTagRoute, { method: "POST", body: { name: " vip " } });
      expect(dup.status).toBe(409);
      expect(await (await db()).tag.count({ where: { organizationId: t.orgA.id } })).toBe(1);
    });

    it("allows the same tag name in a different organization", async () => {
      await call(createTagRoute, { method: "POST", body: { name: "VIP" } });
      as(t.ownerB);
      expect((await call(createTagRoute, { method: "POST", body: { name: "VIP" } })).status).toBe(
        201,
      );
    });

    it.each([
      ["empty", { name: "" }],
      ["blank", { name: "   " }],
      ["too long", { name: "x".repeat(41) }],
      ["extra field", { name: "ok", organizationId: crypto.randomUUID() }],
    ])("returns 400 for %s name", async (_label, body) => {
      expect((await call(createTagRoute, { method: "POST", body })).status).toBe(400);
    });

    it("lists tags with the number of customers using each", async () => {
      const vip = await seedTag(t.orgA.id, "VIP");
      await seedTag(t.orgA.id, "Trial");
      await seedTagLink(t.orgA.id, customer.id, vip.id);
      const res = await call(listTagsRoute);
      expect(
        res.body.tags.map((tag: { name: string; customerCount: number }) => [
          tag.name,
          tag.customerCount,
        ]),
      ).toEqual([
        ["Trial", 0],
        ["VIP", 1],
      ]);
    });

    it("lets only ADMIN and above rename or delete shared tags", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      expect(
        (
          await call(renameTagRoute, {
            method: "PATCH",
            params: { tagId: tag.id },
            body: { name: "Gold" },
          })
        ).status,
      ).toBe(403);
      expect(
        (await call(deleteTagRoute, { method: "DELETE", params: { tagId: tag.id } })).status,
      ).toBe(403);

      as(t.adminA);
      const renamed = await call(renameTagRoute, {
        method: "PATCH",
        params: { tagId: tag.id },
        body: { name: "Gold" },
      });
      expect(renamed.body.tag.name).toBe("Gold");
      await seedTag(t.orgA.id, "Silver");
      const clash = await call(renameTagRoute, {
        method: "PATCH",
        params: { tagId: tag.id },
        body: { name: "silver" },
      });
      expect(clash.status).toBe(409);
    });

    it("detaches a deleted tag from customers without deleting the customers", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      await seedTagLink(t.orgA.id, customer.id, tag.id);
      as(t.adminA);
      expect(
        (await call(deleteTagRoute, { method: "DELETE", params: { tagId: tag.id } })).status,
      ).toBe(204);
      expect(await (await db()).customerTag.count()).toBe(0);
      expect(await (await db()).customer.count({ where: { id: customer.id } })).toBe(1);
      expect(
        (await call(deleteTagRoute, { method: "DELETE", params: { tagId: tag.id } })).status,
      ).toBe(404);
    });
  });

  describe("tags on a customer", () => {
    it("assigns an existing tag by id and records TAG_ADDED", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      const res = await call(assignTagRoute, {
        method: "POST",
        params: cid(),
        body: { tagId: tag.id },
      });
      expect(res.status).toBe(201);
      expect(res.body.tag).toMatchObject({ id: tag.id, name: "VIP" });

      const list = await call(listCustomerTagsRoute, { params: cid() });
      expect(list.body.tags.map((x: { name: string }) => x.name)).toEqual(["VIP"]);

      const [activity] = await activitiesOf(customer.id);
      expect(activity).toMatchObject({
        type: "TAG_ADDED",
        title: 'Tag "VIP" added',
        actorId: t.memberA.id,
      });
      expect(activity.metadata).toEqual({ tagId: tag.id, tagName: "VIP" });
    });

    it("find-or-creates a tag by name, reusing an existing one case-insensitively", async () => {
      const existing = await seedTag(t.orgA.id, "VIP");
      const reuse = await call(assignTagRoute, {
        method: "POST",
        params: cid(),
        body: { name: " vip" },
      });
      expect(reuse.body.tag.id).toBe(existing.id);

      const other = await seedCustomer(t.orgA.id, { firstName: "Grace" });
      const created = await call(assignTagRoute, {
        method: "POST",
        params: { customerId: other.id },
        body: { name: "Brand New" },
      });
      expect(created.status).toBe(201);
      expect(await (await db()).tag.count({ where: { organizationId: t.orgA.id } })).toBe(2);
    });

    it("rejects assigning the same tag twice with 409 and keeps a single link", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      await call(assignTagRoute, { method: "POST", params: cid(), body: { tagId: tag.id } });
      const dup = await call(assignTagRoute, {
        method: "POST",
        params: cid(),
        body: { tagId: tag.id },
      });
      expect(dup.status).toBe(409);
      expect(await (await db()).customerTag.count({ where: { customerId: customer.id } })).toBe(1);
      expect(await activitiesOf(customer.id)).toHaveLength(1);
    });

    it("returns 404 for an unknown tag id and 400 for a malformed body", async () => {
      expect(
        (
          await call(assignTagRoute, {
            method: "POST",
            params: cid(),
            body: { tagId: crypto.randomUUID() },
          })
        ).status,
      ).toBe(404);
      expect((await call(assignTagRoute, { method: "POST", params: cid(), body: {} })).status).toBe(
        400,
      );
    });

    it("removes a tag and records TAG_REMOVED; removing it again is a 404", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      await seedTagLink(t.orgA.id, customer.id, tag.id);
      const res = await call(removeTagRoute, { method: "DELETE", params: cid({ tagId: tag.id }) });
      expect(res.status).toBe(204);
      expect(await (await db()).customerTag.count()).toBe(0);
      expect((await activitiesOf(customer.id)).map((a) => a.type)).toEqual(["TAG_REMOVED"]);
      const again = await call(removeTagRoute, {
        method: "DELETE",
        params: cid({ tagId: tag.id }),
      });
      expect(again.status).toBe(404);
    });
  });

  describe("notes", () => {
    it("adds a note authored by the caller and records NOTE_ADDED", async () => {
      const res = await call(addNoteRoute, {
        method: "POST",
        params: cid(),
        body: { content: "  Asked about enterprise pricing  " },
      });
      expect(res.status).toBe(201);
      expect(res.body.note).toMatchObject({
        content: "Asked about enterprise pricing",
        author: { id: t.memberA.id },
      });

      const row = await (
        await db()
      ).customerNote.findUniqueOrThrow({ where: { id: res.body.note.id } });
      expect(row).toMatchObject({
        organizationId: t.orgA.id,
        customerId: customer.id,
        authorId: t.memberA.id,
      });
      const [activity] = await activitiesOf(customer.id);
      expect(activity).toMatchObject({
        type: "NOTE_ADDED",
        description: "Asked about enterprise pricing",
      });
      expect(activity.metadata).toEqual({ noteId: res.body.note.id });
    });

    it("truncates long notes in the timeline preview but stores them in full", async () => {
      const content = "x".repeat(500);
      await call(addNoteRoute, { method: "POST", params: cid(), body: { content } });
      const [activity] = await activitiesOf(customer.id);
      expect(activity.description!.length).toBeLessThanOrEqual(140);
      expect((await (await db()).customerNote.findFirstOrThrow()).content).toHaveLength(500);
    });

    it.each([
      ["empty", { content: "" }],
      ["blank", { content: "   " }],
      ["too long", { content: "x".repeat(5001) }],
      ["spoofed author", { content: "hi", authorId: crypto.randomUUID() }],
      ["missing", {}],
    ])("returns 400 for %s content and writes nothing", async (_label, body) => {
      expect((await call(addNoteRoute, { method: "POST", params: cid(), body })).status).toBe(400);
      expect(await (await db()).customerNote.count()).toBe(0);
      expect(await activitiesOf(customer.id)).toHaveLength(0);
    });

    it("lists notes newest first with pagination", async () => {
      for (const content of ["first", "second", "third"]) {
        await call(addNoteRoute, { method: "POST", params: cid(), body: { content } });
      }
      const page1 = await call(listNotesRoute, { params: cid(), query: { pageSize: "2" } });
      expect(page1.body.items.map((n: { content: string }) => n.content)).toEqual([
        "third",
        "second",
      ]);
      expect(page1.body).toMatchObject({ total: 3, totalPages: 2 });
      const page2 = await call(listNotesRoute, {
        params: cid(),
        query: { pageSize: "2", page: "2" },
      });
      expect(page2.body.items.map((n: { content: string }) => n.content)).toEqual(["first"]);
    });
  });

  describe("timeline", () => {
    it("returns every kind of activity newest first and keeps lastActivityAt current", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      await call(assignTagRoute, { method: "POST", params: cid(), body: { tagId: tag.id } });
      await call(addNoteRoute, { method: "POST", params: cid(), body: { content: "hello" } });
      as(t.adminA);
      const { DELETE } = await import("@/app/api/customers/[customerId]/route");
      await call(DELETE, { method: "DELETE", params: cid() });

      const res = await call(activitiesRoute, { params: cid() });
      expect(res.body.items.map((a: { type: string }) => a.type)).toEqual([
        "CUSTOMER_ARCHIVED",
        "NOTE_ADDED",
        "TAG_ADDED",
      ]);
      expect(res.body.total).toBe(3);

      const row = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(row.lastActivityAt.getTime()).toBe(new Date(res.body.items[0].createdAt).getTime());
    });

    it("does not count tag or note activity as a profile update", async () => {
      const before = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      await call(addNoteRoute, { method: "POST", params: cid(), body: { content: "hello" } });
      const after = await (await db()).customer.findUniqueOrThrow({ where: { id: customer.id } });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      expect(after.lastActivityAt.getTime()).toBeGreaterThan(before.lastActivityAt.getTime());
    });

    it("includes tags, notes and counts in the Customer 360 response", async () => {
      const tag = await seedTag(t.orgA.id, "VIP");
      await call(assignTagRoute, { method: "POST", params: cid(), body: { tagId: tag.id } });
      await call(addNoteRoute, { method: "POST", params: cid(), body: { content: "hello" } });
      const res = await call(getCustomerRoute, { params: cid() });
      expect(res.body.tags.map((x: { name: string }) => x.name)).toEqual(["VIP"]);
      expect(res.body.notes).toHaveLength(1);
      expect(res.body.recentActivities).toHaveLength(2);
      expect(res.body.counts).toEqual({ activities: 2, notes: 1 });
    });
  });
});
