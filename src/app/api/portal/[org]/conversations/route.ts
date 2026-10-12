import { NextResponse } from "next/server";
import { portalCreateConversationSchema, portalPageSchema } from "@/features/portal/schemas";
import { parseQuery } from "@/server/http/handler";
import { createPortalConversation, listPortalConversations } from "@/server/portal/conversations";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";
import { parsePublicBody } from "@/server/widget/http";

export const GET = portalHandler(async (request, ctx) => {
  await limitCustomer(ctx, "read", PORTAL_LIMITS.reads);
  return NextResponse.json(
    await listPortalConversations(ctx, parseQuery(request, portalPageSchema)),
  );
});

/** The customer is the linked customer (server side). The body has a subject, a message and an idempotency id. */
export const POST = portalHandler(async (request, ctx) => {
  await limitCustomer(ctx, "conversation", PORTAL_LIMITS.newConversations);
  const input = await parsePublicBody(request, portalCreateConversationSchema);
  const { duplicate, ...result } = await createPortalConversation(ctx, input);
  return NextResponse.json(result, { status: duplicate ? 200 : 201 });
});
