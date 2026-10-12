import { transaction } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import { createLogger } from "@/lib/logger";
import { getIdentityProfile } from "@/server/auth/identity";
import { AppError, ConflictError, NotFoundError } from "@/server/errors";
import { customersRepository } from "@/server/repositories/customers";
import { portalAccountsRepository, portalInvitesRepository } from "@/server/repositories/portal";
import type { AppUser } from "@/server/repositories/users";
import { hashToken } from "./tokens";

const log = createLogger("portal");

const invalidInvite = () => new NotFoundError("This invitation is invalid or has expired");

/**
 * The ONLY way an identity gets access to a customer record: redeeming a staff-issued invitation.
 *
 * Both factors are required, and neither is enough alone:
 *   1. possession of the single-use, expiring invitation token for THAT customer (hash lookup, scoped to
 *      the portal's organization), and
 *   2. the identity's own verified email (from the identity provider, fetched here, never from the
 *      client) equals the customer's email.
 * A matching email without an invitation grants nothing; an invitation forwarded to someone with a
 * different (or unverified) email grants nothing.
 *
 * Integrity: the invitation is consumed with one conditional UPDATE (single use, also under
 * concurrency) and the link row is protected by two unique constraints (one customer per identity per
 * organization, one identity per customer), so duplicate and concurrent links end in a conflict, never in
 * two accounts. Redeeming again with the identity that already owns the link is idempotent.
 */
export async function redeemPortalInvite(params: {
  user: AppUser;
  organizationId: string;
  token: string;
  now?: Date;
}): Promise<{ customerId: string; alreadyLinked: boolean }> {
  const { user, organizationId } = params;
  const now = params.now ?? new Date();

  const invite = await portalInvitesRepository.findByTokenHash(
    organizationId,
    hashToken(params.token),
  );
  if (!invite || invite.expiresAt <= now) throw invalidInvite();

  const customer = await customersRepository.findById(organizationId, invite.customerId);
  if (!customer || customer.status === "ARCHIVED" || !customer.email) throw invalidInvite();

  // Already the owner of this very link (a retry of the same redemption).
  const existing = await portalAccountsRepository.findByUser(organizationId, user.id);
  if (existing?.customerId === customer.id) return { customerId: customer.id, alreadyLinked: true };
  // A used invitation is dead for everybody else (and says so before any identity check).
  if (invite.usedAt) throw invalidInvite();

  const profile = await getIdentityProfile(user.authProviderId);
  if (!profile?.emailVerified || profile.email.toLowerCase() !== customer.email.toLowerCase()) {
    log.warn({ organizationId, userId: user.id }, "portal invite refused: identity email mismatch");
    throw new AppError(
      403,
      "invite_email_mismatch",
      "This invitation was issued for a different, verified email address",
    );
  }

  try {
    await transaction(async (tx) => {
      if (!(await portalInvitesRepository.markUsed(organizationId, invite.id, now, tx))) {
        throw invalidInvite(); // used or expired in the meantime (concurrent redemption)
      }
      await portalAccountsRepository.create(
        { organizationId, customerId: customer.id, userId: user.id },
        tx,
      );
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      log.warn({ organizationId, userId: user.id }, "portal link conflict");
      throw new ConflictError(
        "This account or this customer profile is already linked. Ask support for help.",
      );
    }
    throw error;
  }
  log.info({ organizationId, userId: user.id }, "portal account linked");
  return { customerId: customer.id, alreadyLinked: false };
}
