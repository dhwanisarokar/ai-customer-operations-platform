import { requireOrganizationContext } from "@/server/auth/context";
import { ForbiddenError } from "@/server/errors";
import { apiHandler } from "@/server/http/handler";
import { canAgentSubscribe, inboxChannel } from "@/server/realtime/channels";
import { sseResponse } from "@/server/realtime/sse";

export const dynamic = "force-dynamic";

/**
 * Realtime hints for the inbox of the caller's OWN organization (from their Clerk membership).
 * The channel is derived server-side; nothing in the request can select another organization.
 */
export const GET = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const channel = inboxChannel(ctx.organization.id);
  if (!canAgentSubscribe(ctx, channel)) throw new ForbiddenError();
  return sseResponse(request, channel);
});
