import { requireUser } from "@/server/auth/context";
import { AppError, NotFoundError } from "@/server/errors";
import { customersRepository } from "@/server/repositories/customers";
import {
  portalAccountsRepository,
  portalOrganizationsRepository,
} from "@/server/repositories/portal";
import type { AppUser } from "@/server/repositories/users";

/**
 * The third authorization context (next to staff memberships and anonymous visitor sessions): an
 * AUTHENTICATED customer. It is derived entirely on the server:
 *
 *   Clerk identity -> app user -> customer_portal_accounts row (organization + user) -> customer
 *
 * The organization slug in the URL only SELECTS the organization; it grants nothing. Without an explicit
 * link row the identity has no access, however its email compares to any customer's email.
 */
export type PortalContext = {
  user: AppUser;
  organization: { id: string; name: string; slug: string };
  customer: {
    id: string;
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
};

export class PortalNotLinkedError extends AppError {
  constructor() {
    super(403, "portal_not_linked", "Your account is not linked to a customer profile");
  }
}

/** The organization of a portal URL. Unknown and disabled portals are indistinguishable (404). */
export async function requirePortalOrganization(slug: string) {
  const organization = await portalOrganizationsRepository.findBySlug(slug.toLowerCase());
  if (!organization || !organization.portalEnabled) throw new NotFoundError("Portal not found");
  return { id: organization.id, name: organization.name, slug: organization.slug };
}

export async function requirePortalContext(slug: string): Promise<PortalContext> {
  const user = await requireUser(); // 401 when signed out
  const organization = await requirePortalOrganization(slug);

  const account = await portalAccountsRepository.findByUser(organization.id, user.id);
  if (!account) throw new PortalNotLinkedError();

  // Organization-scoped lookup: the link's customer must belong to THIS organization (the composite
  // foreign key guarantees it too) and must not be archived.
  const customer = await customersRepository.findById(organization.id, account.customerId);
  if (!customer || customer.status === "ARCHIVED") throw new PortalNotLinkedError();

  return {
    user,
    organization,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
  };
}

/**
 * Authenticated, but not necessarily linked: used by the invitation page and the "who am I" endpoint,
 * which must work BEFORE a link exists. Still 404 for an unknown or disabled portal.
 */
export async function requirePortalIdentity(slug: string) {
  const user = await requireUser();
  const organization = await requirePortalOrganization(slug);
  const account = await portalAccountsRepository.findByUser(organization.id, user.id);
  return { user, organization, linked: account !== null };
}
