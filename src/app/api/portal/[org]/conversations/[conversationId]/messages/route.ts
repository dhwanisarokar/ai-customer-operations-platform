import { NextResponse } from "next/server";
import { portalSendMessageSchema } from "@/features/portal/schemas";
import { parseUuidParam } from "@/server/http/params";
import { sendPortalMessage } from "@/server/portal/conversations";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";
import { parsePublicBody } from "@/server/widget/http";

/** The author is always the linked customer; a retry with the same clientMessageId never duplicates. */
export const POST = portalHandler<{ org: string; conversationId: string }>(
  async (request, ctx, params) => {
    await limitCustomer(ctx, "message", PORTAL_LIMITS.messages);
    const id = parseUuidParam(params.conversationId, "Conversation");
    const input = await parsePublicBody(request, portalSendMessageSchema);
    const result = await sendPortalMessage(ctx, id, input);
    return NextResponse.json({ message: result.message }, { status: result.duplicate ? 200 : 201 });
  },
);
