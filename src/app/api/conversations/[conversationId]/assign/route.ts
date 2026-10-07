import { NextResponse } from "next/server";
import { assignConversationSchema } from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { assignConversation } from "@/server/services/conversations";

export const POST = apiHandler<{ conversationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const { userId } = await parseJsonBody(request, assignConversationSchema);
  return NextResponse.json({ conversation: await assignConversation(ctx, id, userId) });
});
