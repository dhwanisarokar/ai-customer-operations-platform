import { NextResponse } from "next/server";
import { handlingModeSchema } from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { setHandlingMode } from "@/server/services/conversation-handling";

/** Switch who answers the visitor: the AI or only people. The organization comes from the session. */
export const POST = apiHandler<{ conversationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const { mode } = await parseJsonBody(request, handlingModeSchema);
  return NextResponse.json({ conversation: await setHandlingMode(ctx, id, mode) });
});
