import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { seedCustomer, seedTag, seedTagLink, setupTenants } from "../helpers/tenants";

describeDb("customer database integrity", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
  });
  afterAll(disconnectDatabase);

  describe("tenant-aware uniqueness", () => {
    it("rejects a duplicate email within an organization", async () => {
      await seedCustomer(t.orgA.id, { email: "x@example.com" });
      await expect(seedCustomer(t.orgA.id, { email: "x@example.com" })).rejects.toMatchObject({
        code: "P2002",
      });
    });

    it("allows the same email and external id in different organizations", async () => {
      await seedCustomer(t.orgA.id, { email: "x@example.com", externalId: "e1" });
      await expect(
        seedCustomer(t.orgB.id, { email: "x@example.com", externalId: "e1" }),
      ).resolves.toBeDefined();
    });

    it("allows many customers without an email", async () => {
      await seedCustomer(t.orgA.id, { email: null });
      await expect(seedCustomer(t.orgA.id, { email: null })).resolves.toBeDefined();
    });

    it("rejects duplicate tag names per organization, not across organizations", async () => {
      await seedTag(t.orgA.id, "VIP");
      await expect(seedTag(t.orgA.id, "VIP")).rejects.toMatchObject({ code: "P2002" });
      await expect(seedTag(t.orgB.id, "VIP")).resolves.toBeDefined();
    });

    it("rejects a duplicate customer/tag link", async () => {
      const customer = await seedCustomer(t.orgA.id);
      const tag = await seedTag(t.orgA.id, "VIP");
      await seedTagLink(t.orgA.id, customer.id, tag.id);
      await expect(seedTagLink(t.orgA.id, customer.id, tag.id)).rejects.toMatchObject({
        code: "P2002",
      });
    });
  });

  describe("composite foreign keys keep children inside one organization", () => {
    it("rejects linking a tag from another organization", async () => {
      const customer = await seedCustomer(t.orgA.id);
      const foreignTag = await seedTag(t.orgB.id, "Secret");
      // Even if application code forgot its checks, the database refuses the pair.
      await expect(
        (await db()).customerTag.create({
          data: { organizationId: t.orgA.id, customerId: customer.id, tagId: foreignTag.id },
        }),
      ).rejects.toThrow();
      await expect(
        (await db()).customerTag.create({
          data: { organizationId: t.orgB.id, customerId: customer.id, tagId: foreignTag.id },
        }),
      ).rejects.toThrow();
    });

    it("rejects notes and activities whose organization differs from the customer's", async () => {
      const customer = await seedCustomer(t.orgA.id);
      const client = await db();
      await expect(
        client.customerNote.create({
          data: { organizationId: t.orgB.id, customerId: customer.id, content: "x" },
        }),
      ).rejects.toThrow();
      await expect(
        client.customerActivity.create({
          data: {
            organizationId: t.orgB.id,
            customerId: customer.id,
            type: "NOTE_ADDED",
            title: "x",
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("check constraints", () => {
    const insert = async (columns: string, values: string) =>
      (await db()).$executeRawUnsafe(
        `INSERT INTO customers (id, "organizationId", ${columns}) VALUES (gen_random_uuid(), '${t.orgA.id}', ${values})`,
      );

    it("rejects non-normalized emails and phones", async () => {
      await expect(insert(`"firstName", email`, `'A', 'Upper@Example.com'`)).rejects.toThrow();
      await expect(insert(`"firstName", phone`, `'A', '555-1234'`)).rejects.toThrow();
      await expect(insert(`"firstName", phone`, `'A', '+12'`)).rejects.toThrow();
      await expect(
        insert(`"firstName", email, phone`, `'A', 'ok@example.com', '+15550100'`),
      ).resolves.toBe(1);
    });

    it("rejects blank first names", async () => {
      await expect(insert(`"firstName"`, `'   '`)).rejects.toThrow();
    });

    it("keeps status and archivedAt consistent", async () => {
      await expect(insert(`"firstName", status`, `'A', 'ARCHIVED'`)).rejects.toThrow();
      await expect(
        insert(`"firstName", status, "archivedAt"`, `'A', 'ACTIVE', now()`),
      ).rejects.toThrow();
      await expect(
        insert(`"firstName", status, "archivedAt"`, `'A', 'ARCHIVED', now()`),
      ).resolves.toBe(1);
    });

    it("rejects invalid enum values", async () => {
      await expect(insert(`"firstName", status`, `'A', 'VIP'`)).rejects.toThrow();
    });
  });

  describe("cascades", () => {
    it("removes everything owned by a deleted customer", async () => {
      const customer = await seedCustomer(t.orgA.id);
      const tag = await seedTag(t.orgA.id, "VIP");
      await seedTagLink(t.orgA.id, customer.id, tag.id);
      const client = await db();
      await client.customerNote.create({
        data: { organizationId: t.orgA.id, customerId: customer.id, content: "n" },
      });
      await client.customerActivity.create({
        data: {
          organizationId: t.orgA.id,
          customerId: customer.id,
          type: "NOTE_ADDED",
          title: "n",
        },
      });

      await client.customer.delete({ where: { id: customer.id } });
      expect(await client.customerTag.count()).toBe(0);
      expect(await client.customerNote.count()).toBe(0);
      expect(await client.customerActivity.count()).toBe(0);
      expect(await client.tag.count({ where: { id: tag.id } })).toBe(1);
    });

    it("removes all customer data with its organization", async () => {
      await seedCustomer(t.orgB.id);
      await seedTag(t.orgB.id, "VIP");
      const client = await db();
      await client.organization.delete({ where: { id: t.orgB.id } });
      expect(await client.customer.count({ where: { organizationId: t.orgB.id } })).toBe(0);
      expect(await client.tag.count({ where: { organizationId: t.orgB.id } })).toBe(0);
    });

    it("keeps a note when its author is deleted", async () => {
      const customer = await seedCustomer(t.orgA.id);
      const client = await db();
      const note = await client.customerNote.create({
        data: {
          organizationId: t.orgA.id,
          customerId: customer.id,
          authorId: t.memberA.id,
          content: "n",
        },
      });
      await client.user.delete({ where: { id: t.memberA.id } });
      const kept = await client.customerNote.findUniqueOrThrow({ where: { id: note.id } });
      expect(kept.authorId).toBeNull();
    });
  });
});
