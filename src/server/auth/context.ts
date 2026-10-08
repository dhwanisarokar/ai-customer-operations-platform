import { readActiveOrganizationId } from "@/server/auth/active-organization";
import { getIdentity } from "@/server/auth/identity";
import { hasPermission, type Permission, type Role } from "@/server/auth/permissions";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/server/errors";
import { membershipsRepository } from "@/server/repositories/memberships";
import type { AppUser } from "@/server/repositories/users";
import { getOrCreateUser } from "@/server/services/users";

export type OrganizationContext = {
  user: AppUser;
  organization: { id: string; name: string; slug: string };
  membership: { id: string; role: Role };
  can(permission: Permission): boolean;
  /** Throws ForbiddenError unless the member's role grants `permission`. */
  require(permission: Permission): void;
};

/** Authentication: who is calling? Throws 401 when signed out. */
export async function requireUser(): Promise<AppUser> {
  const identity = await getIdentity();
  if (!identity) throw new UnauthorizedError();
  return getOrCreateUser(identity);
}

/**
 * Tenant context: which organization is the caller acting in, and with what role?
 *
 * - With `organizationId`, membership is verified against the database. Non-members get the same
 *   404 as a nonexistent organization, so existence is never leaked across tenants.
 * - Without it, the active-organization cookie is tried (and re-verified), then the user's first
 *   membership.
 */
export async function requireOrganizationContext(
  organizationId?: string,
): Promise<OrganizationContext> {
  const user = await requireUser();
  return resolveOrganizationContext(user, organizationId);
}

export async function resolveOrganizationContext(
  user: AppUser,
  organizationId?: string,
): Promise<OrganizationContext> {
  if (organizationId) {
    const membership = await membershipsRepository.findForUserInOrganization(
      user.id,
      organizationId,
    );
    if (!membership) throw new NotFoundError("Organization not found");
    return buildContext(user, membership);
  }

  const preferred = await readActiveOrganizationId();
  if (preferred) {
    const membership = await membershipsRepository.findForUserInOrganization(user.id, preferred);
    if (membership) return buildContext(user, membership);
  }

  const [first] = await membershipsRepository.listForUser(user.id);
  if (!first) throw new NotFoundError("You do not belong to any organization");
  return buildContext(user, first);
}

/** The same context `resolveOrganizationContext` builds, from a membership that is already loaded. */
export function contextFromMembership(
  user: AppUser,
  membership: { id: string; role: Role; organization: { id: string; name: string; slug: string } },
): OrganizationContext {
  return buildContext(user, membership);
}

function buildContext(
  user: AppUser,
  membership: { id: string; role: Role; organization: { id: string; name: string; slug: string } },
): OrganizationContext {
  const { organization } = membership;
  const role = membership.role;
  return {
    user,
    organization: { id: organization.id, name: organization.name, slug: organization.slug },
    membership: { id: membership.id, role },
    can: (permission) => hasPermission(role, permission),
    require(permission) {
      if (!hasPermission(role, permission)) throw new ForbiddenError();
    },
  };
}
