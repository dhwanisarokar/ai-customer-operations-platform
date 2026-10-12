import { NextResponse } from "next/server";
import { parseUuidParam } from "@/server/http/params";
import { requestPortalHuman } from "@/server/portal/conversations";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";

/** "Talk to a person": no body, nothing is trusted from the client. */
export const POST = portalHandler<{ org: string; conversationId: string }>(
  async (_request, ctx, params) => {
    await limitCustomer(ctx, "handoff", PORTAL_LIMITS.handoff);
    const id = parseUuidParam(params.conversationId, "Conversation");
    return NextResponse.json(await requestPortalHuman(ctx, id));
  },
);
