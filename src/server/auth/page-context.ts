import { cache } from "react";
import { redirect } from "next/navigation";
import { requireOrganizationContext, type OrganizationContext } from "@/server/auth/context";
import { NotFoundError, UnauthorizedError } from "@/server/errors";

type Loaded = { ctx: OrganizationContext } | { error: unknown };

/** Resolved once per request (React cache): the layout and the page share one tenant lookup. */
const loadContext = cache(async (): Promise<Loaded> => {
  try {
    return { ctx: await requireOrganizationContext() };
  } catch (error) {
    return { error };
  }
});

/**
 * Tenant context for server-rendered pages. Same verification as API routes, but failures turn
 * into navigation: signed out goes to sign-in, no organization goes to the dashboard (where one
 * can be created).
 */
export async function requirePageContext(): Promise<OrganizationContext> {
  const loaded = await loadContext();
  if ("ctx" in loaded) return loaded.ctx;
  if (loaded.error instanceof UnauthorizedError) redirect("/sign-in");
  if (loaded.error instanceof NotFoundError) redirect("/dashboard");
  throw loaded.error;
}

/**
 * The verified active organization id, or null when the user has none yet. Used by the dashboard
 * layout to namespace the client-side query cache; it is not an authorization input.
 */
export async function getActiveOrganizationId(): Promise<string | null> {
  const loaded = await loadContext();
  if ("ctx" in loaded) return loaded.ctx.organization.id;
  if (loaded.error instanceof UnauthorizedError || loaded.error instanceof NotFoundError)
    return null;
  throw loaded.error;
}
