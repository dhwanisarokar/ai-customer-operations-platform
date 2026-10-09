import { NextResponse } from "next/server";
import { widgetCreateConversationSchema } from "@/features/widget/schemas";
import { parsePublicBody } from "@/server/widget/http";
import { limitVisitor, visitorHandler, WIDGET_LIMITS } from "@/server/widget/route";
import { createVisitorConversation, listVisitorConversations } from "@/server/widget/visitor";

export const GET = visitorHandler(async (request, visitor) => {
  await limitVisitor(visitor, request, { session: ["widget-read", WIDGET_LIMITS.readsPerSession] });
  return NextResponse.json({ conversations: await listVisitorConversations(visitor) });
});

export const POST = visitorHandler(async (request, visitor) => {
  await limitVisitor(visitor, request, {
    session: ["widget-conversation", WIDGET_LIMITS.conversationsPerSession],
    ip: ["widget-conversation", WIDGET_LIMITS.conversationsPerIp],
  });
  const body = await parsePublicBody(request, widgetCreateConversationSchema);
  const { duplicate, ...result } = await createVisitorConversation(visitor, body);
  return NextResponse.json(result, { status: duplicate ? 200 : 201 });
});
