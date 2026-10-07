import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { generateAiDraft } from "@/server/services/ai-draft";

const emptyBodySchema = z.object({}).strict();

/**
 * Generates a suggested reply (an AI draft) for a human to review. Read-only: it stores nothing and
 * never sends anything to the customer; the draft becomes a message only when a person sends it via
 * POST /messages. The request takes no parameters: the conversation, customer and organization come
 * from the server, never the client. A body, if sent, must be an empty JSON object.
 */
export const POST = apiHandler<{ conversationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  if ((await request.clone().text()).trim()) await parseJsonBody(request, emptyBodySchema);
  return NextResponse.json(await generateAiDraft(ctx, id), { status: 200 });
});
