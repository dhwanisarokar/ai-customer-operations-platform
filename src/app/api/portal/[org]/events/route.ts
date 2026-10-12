import { ForbiddenError } from "@/server/errors";
import { canPortalSubscribe, portalChannel } from "@/server/realtime/channels";
import { sseResponse } from "@/server/realtime/sse";
import { portalHandler } from "@/server/portal/route";

export const dynamic = "force-dynamic";

/**
 * Realtime hints for ONE portal customer. The channel is derived from the verified link (organization +
 * customer), never from the request, so it cannot name anyone else's.
 */
export const GET = portalHandler(async (request, ctx) => {
  const channel = portalChannel(ctx.organization.id, ctx.customer.id);
  if (
    !canPortalSubscribe(
      { organizationId: ctx.organization.id, customerId: ctx.customer.id },
      channel,
    )
  ) {
    throw new ForbiddenError();
  }
  return sseResponse(request, channel);
});
