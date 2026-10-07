import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { unassignConversation } from "@/server/services/conversations";

export const POST = apiHandler<{ conversationId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  return NextResponse.json({ conversation: await unassignConversation(ctx, id) });
});
