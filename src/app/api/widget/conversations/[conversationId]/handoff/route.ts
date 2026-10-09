import { NextResponse } from "next/server";
import { parseUuidParam } from "@/server/http/params";
import { limitVisitor, visitorHandler, WIDGET_LIMITS } from "@/server/widget/route";
import { requestHuman } from "@/server/widget/visitor";

/** "Talk to a person": marks the conversation for the inbox. No body; nothing is trusted from the client. */
export const POST = visitorHandler<{ conversationId: string }>(async (request, visitor, params) => {
  await limitVisitor(visitor, request, {
    session: ["widget-handoff", WIDGET_LIMITS.handoffPerSession],
  });
  const id = parseUuidParam(params.conversationId, "Conversation");
  return NextResponse.json(await requestHuman(visitor, id));
});
