import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { generateAiReply } from "@/server/services/ai-reply";

const emptyBodySchema = z.object({}).strict();

/**
 * Generates a grounded AI reply and stores it as an AI_AGENT message. The request takes no
 * parameters: the conversation, customer and organization come from the server, never the client.
 * A body, if sent, must be an empty JSON object.
 */
export const POST = apiHandler<{ conversationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  if ((await request.clone().text()).trim()) await parseJsonBody(request, emptyBodySchema);
  return NextResponse.json({ message: await generateAiReply(ctx, id) }, { status: 201 });
});
