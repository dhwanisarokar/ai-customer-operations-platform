import { NextResponse } from "next/server";
import { widgetSendMessageSchema } from "@/features/widget/schemas";
import { parseUuidParam } from "@/server/http/params";
import { parsePublicBody } from "@/server/widget/http";
import { limitVisitor, visitorHandler, WIDGET_LIMITS } from "@/server/widget/route";
import { sendVisitorMessage } from "@/server/widget/visitor";

/** The author is always the visitor; a retry with the same clientMessageId never duplicates. */
export const POST = visitorHandler<{ conversationId: string }>(async (request, visitor, params) => {
  await limitVisitor(visitor, request, {
    session: ["widget-message", WIDGET_LIMITS.messagesPerSession],
    ip: ["widget-message", WIDGET_LIMITS.messagesPerIp],
  });
  const id = parseUuidParam(params.conversationId, "Conversation");
  const body = await parsePublicBody(request, widgetSendMessageSchema);
  const result = await sendVisitorMessage(visitor, id, body);
  return NextResponse.json({ message: result.message }, { status: result.duplicate ? 200 : 201 });
});
