import { isUniqueViolation } from "@/db/errors";
import type { CreateOrganizationInput } from "@/features/organizations/schemas";
import { slugify, withRandomSuffix } from "@/features/organizations/slug";
import { createLogger } from "@/lib/logger";
import { ConflictError } from "@/server/errors";
import { membershipsRepository } from "@/server/repositories/memberships";
import {
  organizationsRepository,
  type OrganizationRecord,
} from "@/server/repositories/organizations";
import type { AppUser } from "@/server/repositories/users";

const log = createLogger("organizations");
const MAX_SLUG_ATTEMPTS = 5;

export async function createOrganization(
  user: AppUser,
  input: CreateOrganizationInput,
): Promise<OrganizationRecord> {
  const explicitSlug = input.slug !== undefined;
  let slug = input.slug ?? slugify(input.name);

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    try {
      const organization = await organizationsRepository.createWithOwner({
        name: input.name,
        slug,
        ownerUserId: user.id,
      });
      log.info({ organizationId: organization.id, userId: user.id }, "organization created");
      return organization;
    } catch (error) {
      // The only unique constraint a brand-new organization can violate is its slug.
      if (!isUniqueViolation(error)) throw error;
      if (explicitSlug) throw new ConflictError("That slug is already taken");
      slug = withRandomSuffix(slugify(input.name));
    }
  }
  throw new ConflictError("Could not generate a unique slug; please choose one");
}

export async function listOrganizationsForUser(user: AppUser) {
  const memberships = await membershipsRepository.listForUser(user.id);
  return memberships.map((membership) => ({ ...membership.organization, role: membership.role }));
}
