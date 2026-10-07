import { NextResponse } from "next/server";
import { listMessagesQuerySchema, sendMessageSchema } from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody, parseQuery } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { listMessages, sendMessage } from "@/server/services/conversation-messages";

type Params = { conversationId: string };

export const GET = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const query = parseQuery(request, listMessagesQuerySchema);
  return NextResponse.json(await listMessages(ctx, id, query));
});

export const POST = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const input = await parseJsonBody(request, sendMessageSchema);
  return NextResponse.json({ message: await sendMessage(ctx, id, input) }, { status: 201 });
});
