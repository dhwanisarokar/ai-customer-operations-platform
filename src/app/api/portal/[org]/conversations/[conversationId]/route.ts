import { NextResponse } from "next/server";
import { parseUuidParam } from "@/server/http/params";
import { getPortalConversation } from "@/server/portal/conversations";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";

/** 404 unless THIS customer owns the conversation: a conversation id alone is never enough. */
export const GET = portalHandler<{ org: string; conversationId: string }>(
  async (_request, ctx, params) => {
    await limitCustomer(ctx, "read", PORTAL_LIMITS.reads);
    const id = parseUuidParam(params.conversationId, "Conversation");
    return NextResponse.json(await getPortalConversation(ctx, id));
  },
);
