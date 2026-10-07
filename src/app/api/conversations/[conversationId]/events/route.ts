import { NextResponse } from "next/server";
import { paginationSchema } from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseQuery } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { listConversationEvents } from "@/server/services/conversation-messages";

export const GET = apiHandler<{ conversationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const pagination = parseQuery(request, paginationSchema);
  return NextResponse.json(await listConversationEvents(ctx, id, pagination));
});
