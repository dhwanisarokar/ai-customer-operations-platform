import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { markConversationRead } from "@/server/services/conversations";

/** Marks the conversation as read for the calling member only. */
export const POST = apiHandler<{ conversationId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  await markConversationRead(ctx, id);
  return new NextResponse(null, { status: 204 });
});
