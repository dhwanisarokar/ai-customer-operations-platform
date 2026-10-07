import { describe } from "vitest";
import type { Role } from "@/server/auth/permissions";

/**
 * Integration tests need a real PostgreSQL with all migrations applied. Provide it via
 * TEST_DATABASE_URL (docker compose up -d, then DATABASE_URL=... npm run db:deploy). Without it
 * the integration suites are skipped; they are never faked.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export const describeDb = TEST_DATABASE_URL ? describe : describe.skip;

if (TEST_DATABASE_URL) {
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}

export async function resetDatabase() {
  const { getDb } = await import("@/db/client");
  // Truncating the roots cascades to every tenant-owned table.
  await getDb().$executeRawUnsafe(
    `TRUNCATE TABLE "organizations", "users" RESTART IDENTITY CASCADE`,
  );
}

export async function disconnectDatabase() {
  const { getDb } = await import("@/db/client");
  await getDb().$disconnect();
}

export async function createTestUser(label: string) {
  const { usersRepository } = await import("@/server/repositories/users");
  return usersRepository.create({
    authProviderId: `clerk_${label}`,
    email: `${label}@example.com`,
    name: label,
  });
}

/** Creates an organization through the real service; the user becomes its OWNER. */
export async function createTestOrganization(owner: { id: string }, name: string) {
  const { createOrganization } = await import("@/server/services/organizations");
  return createOrganization(owner as Parameters<typeof createOrganization>[0], { name });
}

export async function addTestMember(organizationId: string, userId: string, role: Role) {
  const { membershipsRepository } = await import("@/server/repositories/memberships");
  await membershipsRepository.create(organizationId, userId, role);
}
