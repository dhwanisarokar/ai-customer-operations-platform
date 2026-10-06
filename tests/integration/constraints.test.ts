import { afterAll, beforeEach, expect, it } from "vitest";
import {
  createTestOrganization,
  createTestUser,
  describeDb,
  disconnectDatabase,
  resetDatabase,
} from "../helpers/db";

describeDb("database integrity", () => {
  beforeEach(resetDatabase);
  afterAll(disconnectDatabase);

  async function db() {
    return (await import("@/db/client")).getDb();
  }

  it("rejects blank organization names at the database level", async () => {
    await expect(
      (await db()).$executeRawUnsafe(
        `INSERT INTO organizations (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), '  ', 'ok-slug', now())`,
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed slugs at the database level", async () => {
    for (const slug of ["Bad Slug", "-lead", "trail-", "a", "double--hyphen"]) {
      await expect(
        (await db()).$executeRawUnsafe(
          `INSERT INTO organizations (id, name, slug, "updatedAt") VALUES (gen_random_uuid(), 'Acme', '${slug}', now())`,
        ),
      ).rejects.toThrow();
    }
  });

  it("enforces unique slugs, emails and auth provider ids", async () => {
    const alice = await createTestUser("alice");
    await createTestOrganization(alice, "Acme");
    const client = await db();
    await expect(
      client.organization.create({ data: { name: "Other", slug: "acme" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      client.user.create({ data: { authProviderId: "clerk_other", email: "alice@example.com" } }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      client.user.create({ data: { authProviderId: "clerk_alice", email: "other@example.com" } }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("rejects invalid roles and orphaned memberships", async () => {
    const alice = await createTestUser("alice");
    const org = await createTestOrganization(alice, "Acme");
    const client = await db();
    await expect(
      client.$executeRawUnsafe(
        `UPDATE memberships SET role = 'SUPERUSER' WHERE "organizationId" = '${org.id}'`,
      ),
    ).rejects.toThrow();
    await expect(
      client.membership.create({ data: { userId: crypto.randomUUID(), organizationId: org.id } }),
    ).rejects.toThrow();
  });

  it("cascades membership deletion with the organization and the user", async () => {
    const alice = await createTestUser("alice");
    const org = await createTestOrganization(alice, "Acme");
    const client = await db();
    await client.organization.delete({ where: { id: org.id } });
    expect(await client.membership.count()).toBe(0);
    expect(await client.user.count()).toBe(1);
  });
});
