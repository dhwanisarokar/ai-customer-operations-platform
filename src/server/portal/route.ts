import { apiHandler } from "@/server/http/handler";
import { enforceRateLimit, type RateLimit } from "@/server/rate-limit";
import { requirePortalContext, type PortalContext } from "./context";

/** Rate limits of the portal API, per authenticated customer (the key is the server-side customer id). */
export const PORTAL_LIMITS = {
  messages: { limit: 30, windowSeconds: 60 } satisfies RateLimit,
  newConversations: { limit: 10, windowSeconds: 3600 } satisfies RateLimit,
  handoff: { limit: 10, windowSeconds: 3600 } satisfies RateLimit,
  profile: { limit: 20, windowSeconds: 3600 } satisfies RateLimit,
  reads: { limit: 300, windowSeconds: 60 } satisfies RateLimit,
  join: { limit: 10, windowSeconds: 3600 } satisfies RateLimit,
};

type OrgParams = { org: string };

/**
 * Wraps a portal API route. The caller is authenticated (Clerk), the organization comes from the URL slug
 * only as a SELECTOR, and the customer comes from the verified link in the database. The handler never
 * sees a client-chosen customer or organization id.
 */
export function portalHandler<P extends OrgParams = OrgParams>(
  handler: (request: Request, ctx: PortalContext, params: P) => Promise<Response>,
) {
  return apiHandler<P>(async (request, { params }) => {
    const resolved = await params;
    const ctx = await requirePortalContext(resolved.org);
    return handler(request, ctx, resolved);
  });
}

export function limitCustomer(ctx: PortalContext, name: string, rule: RateLimit) {
  return enforceRateLimit(`portal-${name}:${ctx.organization.id}:${ctx.customer.id}`, rule);
}
