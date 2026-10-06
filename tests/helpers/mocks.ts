import type { Identity, IdentityProfile } from "@/server/auth/identity";

/**
 * Test doubles for the two request-scoped dependencies (Clerk session and cookies). Everything
 * else in the stack (services, repositories, Prisma, PostgreSQL) runs for real.
 */
export const session = {
  identity: null as Identity | null,
  profiles: new Map<string, IdentityProfile | null>(),
  activeOrganizationId: null as string | null,
};

export function signInAs(authProviderId: string) {
  session.identity = { authProviderId };
}

export function signOut() {
  session.identity = null;
}

export function resetSession() {
  session.identity = null;
  session.profiles.clear();
  session.activeOrganizationId = null;
}

export const identityMock = {
  getIdentity: async () => session.identity,
  getIdentityProfile: async (id: string) => session.profiles.get(id) ?? null,
};

export const activeOrganizationMock = {
  readActiveOrganizationId: async () => session.activeOrganizationId,
  writeActiveOrganizationId: async (id: string) => {
    session.activeOrganizationId = id;
  },
};
