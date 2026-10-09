import { apiHandler } from "@/server/http/handler";
import { clientIp, enforceRateLimit, type RateLimit } from "@/server/rate-limit";
import { requireBearerToken } from "./http";
import { authenticateVisitor, type VisitorContext } from "./session";

/** Rules for the public widget API (per visitor session unless noted). */
export const WIDGET_LIMITS = {
  sessionsPerIp: { limit: 20, windowSeconds: 3600 } satisfies RateLimit,
  sessionResumePerIp: { limit: 300, windowSeconds: 600 } satisfies RateLimit,
  conversationsPerSession: { limit: 5, windowSeconds: 3600 } satisfies RateLimit,
  conversationsPerIp: { limit: 30, windowSeconds: 3600 } satisfies RateLimit,
  messagesPerSession: { limit: 30, windowSeconds: 60 } satisfies RateLimit,
  messagesPerIp: { limit: 120, windowSeconds: 60 } satisfies RateLimit,
  identityPerSession: { limit: 10, windowSeconds: 3600 } satisfies RateLimit,
  handoffPerSession: { limit: 10, windowSeconds: 3600 } satisfies RateLimit,
  readsPerSession: { limit: 240, windowSeconds: 60 } satisfies RateLimit,
};

/**
 * Wraps a route of the PUBLIC widget API. The caller is authenticated as a VISITOR from its bearer
 * token; the organization, session and customer come from that session, never from the request.
 */
export function visitorHandler<P = Record<string, never>>(
  handler: (request: Request, visitor: VisitorContext, params: P) => Promise<Response>,
) {
  return apiHandler<P>(async (request, { params }) => {
    const visitor = await authenticateVisitor(requireBearerToken(request));
    return handler(request, visitor, await params);
  });
}

export async function limitVisitor(
  visitor: VisitorContext,
  request: Request,
  rules: { session?: [string, RateLimit]; ip?: [string, RateLimit] },
) {
  if (rules.session) {
    await enforceRateLimit(`${rules.session[0]}:s:${visitor.session.id}`, rules.session[1]);
  }
  if (rules.ip) await enforceRateLimit(`${rules.ip[0]}:ip:${clientIp(request)}`, rules.ip[1]);
}
