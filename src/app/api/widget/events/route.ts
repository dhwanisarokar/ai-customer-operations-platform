import { visitorChannel } from "@/server/realtime/channels";
import { sseResponse } from "@/server/realtime/sse";
import { visitorHandler } from "@/server/widget/route";

export const dynamic = "force-dynamic";

/**
 * Realtime hints for ONE visitor session. The channel is derived from the authenticated session; the
 * client cannot name a channel, so it cannot listen to anyone else's.
 */
export const GET = visitorHandler(async (request, visitor) =>
  sseResponse(request, visitorChannel(visitor.session.id)),
);
