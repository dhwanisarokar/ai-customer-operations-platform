import { cookies } from "next/headers";
import { z } from "zod";

const COOKIE_NAME = "active_org";

/**
 * The active organization is only a *preference hint* stored in an httpOnly cookie. It is never
 * trusted: every request re-verifies membership before using it (see context.ts).
 */
export async function readActiveOrganizationId(): Promise<string | null> {
  const value = (await cookies()).get(COOKIE_NAME)?.value;
  const parsed = z.uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function writeActiveOrganizationId(organizationId: string): Promise<void> {
  (await cookies()).set(COOKIE_NAME, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}
