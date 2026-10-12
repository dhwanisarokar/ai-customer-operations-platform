import { isUniqueViolation } from "@/db/errors";
import { createLogger } from "@/lib/logger";
import { getIdentityProfile, type Identity } from "@/server/auth/identity";
import { ConflictError, ForbiddenError } from "@/server/errors";
import { usersRepository, type AppUser } from "@/server/repositories/users";

const log = createLogger("users");

/**
 * Just-in-time provisioning: the first authenticated request for an identity creates the local
 * User row from the provider profile. Later requests are a single indexed lookup.
 */
export async function getOrCreateUser(identity: Identity): Promise<AppUser> {
  const existing = await usersRepository.findByAuthProviderId(identity.authProviderId);
  if (existing) return existing;

  const profile = await getIdentityProfile(identity.authProviderId);
  if (!profile) {
    log.warn({ authProviderId: identity.authProviderId }, "identity has no email address");
    throw new ForbiddenError("Your account needs a verified email address");
  }

  try {
    return await usersRepository.create({
      authProviderId: identity.authProviderId,
      email: profile.email,
      name: profile.name,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Either a concurrent request just created this user, or the email belongs to another identity.
    const created = await usersRepository.findByAuthProviderId(identity.authProviderId);
    if (created) return created;
    log.warn(
      { authProviderId: identity.authProviderId },
      "email already linked to another identity",
    );
    throw new ConflictError("This email address is already linked to another account");
  }
}
