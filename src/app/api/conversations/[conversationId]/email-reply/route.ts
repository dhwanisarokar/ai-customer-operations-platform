import { NextResponse } from "next/server";
import { emailReplySchema } from "@/features/conversations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { createOutboundReply } from "@/server/email/outbound";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";

type Params = { conversationId: string };

/**
 * Staff: send a reply to the customer BY EMAIL. The body is only the text and an idempotency key (strict schema):
 * everything else is derived on the server from persisted, organization-scoped records. The provider is never called
 * here: the reply and its outbound send are stored atomically, and a worker delivers it (see docs/email-outbound.md).
 * 201 for a new reply, 200 when the request repeated an earlier one (nothing new was created or queued).
 */
export const POST = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  const input = await parseJsonBody(request, emailReplySchema);
  const result = await createOutboundReply(ctx, id, input);
  return NextResponse.json(
    { message: result.message, delivery: result.delivery, duplicate: result.duplicate },
    { status: result.duplicate ? 200 : 201 },
  );
});
