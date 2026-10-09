import { NextResponse } from "next/server";
import { widgetIdentitySchema } from "@/features/widget/schemas";
import { parsePublicBody } from "@/server/widget/http";
import { limitVisitor, visitorHandler, WIDGET_LIMITS } from "@/server/widget/route";
import { identifyVisitor } from "@/server/widget/visitor";

/** The visitor shares a name/email. The SERVER resolves the customer; no customer id is accepted. */
export const POST = visitorHandler(async (request, visitor) => {
  await limitVisitor(visitor, request, {
    session: ["widget-identity", WIDGET_LIMITS.identityPerSession],
  });
  const body = await parsePublicBody(request, widgetIdentitySchema);
  await identifyVisitor(visitor, body);
  return NextResponse.json({ ok: true });
});
