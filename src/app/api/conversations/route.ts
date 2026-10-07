import { NextResponse } from "next/server";
import {
  createConversationSchema,
  listConversationsQuerySchema,
} from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody, parseQuery } from "@/server/http/handler";
import { createConversation, listConversations } from "@/server/services/conversations";

export const GET = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const query = parseQuery(request, listConversationsQuerySchema);
  return NextResponse.json(await listConversations(ctx, query));
});

export const POST = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, createConversationSchema);
  return NextResponse.json({ conversation: await createConversation(ctx, input) }, { status: 201 });
});
