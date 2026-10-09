import { NextResponse } from "next/server";
import { parseUuidParam } from "@/server/http/params";
import { limitVisitor, visitorHandler, WIDGET_LIMITS } from "@/server/widget/route";
import { getVisitorConversation } from "@/server/widget/visitor";

/** 404 unless THIS visitor session owns the conversation (a conversation id alone is never enough). */
export const GET = visitorHandler<{ conversationId: string }>(async (request, visitor, params) => {
  await limitVisitor(visitor, request, { session: ["widget-read", WIDGET_LIMITS.readsPerSession] });
  const id = parseUuidParam(params.conversationId, "Conversation");
  return NextResponse.json(await getVisitorConversation(visitor, id));
});
