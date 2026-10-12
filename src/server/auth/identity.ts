import { auth, clerkClient } from "@clerk/nextjs/server";

/** The only module that talks to Clerk server-side. Everything else depends on these shapes. */
export type Identity = { authProviderId: string };

export type IdentityProfile = {
  email: string;
  /** True only when the identity provider verified that the user controls this address. */
  emailVerified: boolean;
  name: string | null;
};

/** The authenticated identity of the current request, or null when signed out. */
export async function getIdentity(): Promise<Identity | null> {
  const { userId } = await auth();
  return userId ? { authProviderId: userId } : null;
}

/** Fetches profile data from Clerk. Returns null if the account has no primary email. */
export async function getIdentityProfile(authProviderId: string): Promise<IdentityProfile | null> {
  const client = await clerkClient();
  const user = await client.users.getUser(authProviderId);
  const primary =
    user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId) ??
    user.emailAddresses[0];
  if (!primary) return null;
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return {
    email: primary.emailAddress.toLowerCase(),
    emailVerified: primary.verification?.status === "verified",
    name: name || null,
  };
}
