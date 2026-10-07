import { addTestMember, createTestOrganization, createTestUser } from "./db";
import { resetSession, signInAs } from "./mocks";

export type TestUser = { id: string; authProviderId: string; email: string };

/**
 * Two isolated tenants:
 *   Org A: ownerA (OWNER), adminA (ADMIN), memberA (MEMBER)
 *   Org B: ownerB (OWNER)
 */
export async function setupTenants() {
  resetSession();
  const ownerA = await createTestUser("ownera");
  const adminA = await createTestUser("admina");
  const memberA = await createTestUser("membera");
  const ownerB = await createTestUser("ownerb");
  const orgA = await createTestOrganization(ownerA, "Org A");
  const orgB = await createTestOrganization(ownerB, "Org B");
  await addTestMember(orgA.id, adminA.id, "ADMIN");
  await addTestMember(orgA.id, memberA.id, "MEMBER");
  return { ownerA, adminA, memberA, ownerB, orgA, orgB };
}

export function as(user: { authProviderId: string }) {
  signInAs(user.authProviderId);
}

type CustomerOverrides = Partial<{
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  source: string | null;
  externalId: string | null;
  status: "ACTIVE" | "INACTIVE" | "ARCHIVED";
}>;

/** Inserts a customer straight through the repository (bypassing the API) for fixtures. */
export async function seedCustomer(organizationId: string, overrides: CustomerOverrides = {}) {
  const { customersRepository } = await import("@/server/repositories/customers");
  return customersRepository.create(organizationId, {
    externalId: null,
    firstName: "Test",
    lastName: null,
    email: null,
    phone: null,
    company: null,
    jobTitle: null,
    source: null,
    status: "ACTIVE",
    ...overrides,
  });
}

export async function seedTag(organizationId: string, name: string) {
  const { tagsRepository } = await import("@/server/repositories/tags");
  return tagsRepository.create(organizationId, { name, normalizedName: name.toLowerCase() });
}

export async function seedTagLink(organizationId: string, customerId: string, tagId: string) {
  const { tagsRepository } = await import("@/server/repositories/tags");
  await tagsRepository.assign(organizationId, customerId, tagId);
}

export async function activitiesOf(customerId: string) {
  const { getDb } = await import("@/db/client");
  return getDb().customerActivity.findMany({
    where: { customerId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}
