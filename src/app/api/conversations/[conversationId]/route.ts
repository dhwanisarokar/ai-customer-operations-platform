import { NextResponse } from "next/server";
import { updateConversationSchema } from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { getConversation, updateConversation } from "@/server/services/conversations";

type Params = { conversationId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  return NextResponse.json({ conversation: await getConversation(ctx, id) });
});

/** Subject, status and priority. Assignment has its own endpoints. */
export const PATCH = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const input = await parseJsonBody(request, updateConversationSchema);
  return NextResponse.json({ conversation: await updateConversation(ctx, id, input) });
});
