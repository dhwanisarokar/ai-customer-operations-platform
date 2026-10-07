import { redirect } from "next/navigation";
import { requireOrganizationContext, type OrganizationContext } from "@/server/auth/context";
import { NotFoundError, UnauthorizedError } from "@/server/errors";

/**
 * Tenant context for server-rendered pages. Same verification as API routes, but failures turn
 * into navigation: signed out goes to sign-in, no organization goes to the dashboard (where one
 * can be created).
 */
export async function requirePageContext(): Promise<OrganizationContext> {
  try {
    return await requireOrganizationContext();
  } catch (error) {
    if (error instanceof UnauthorizedError) redirect("/sign-in");
    if (error instanceof NotFoundError) redirect("/dashboard");
    throw error;
  }
}
