import { NextResponse } from "next/server";
import { portalHelpQuerySchema } from "@/features/portal/schemas";
import { parseQuery } from "@/server/http/handler";
import { searchHelpArticles } from "@/server/portal/help";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";

/** Published articles of the portal's organization only. */
export const GET = portalHandler(async (request, ctx) => {
  await limitCustomer(ctx, "read", PORTAL_LIMITS.reads);
  return NextResponse.json(
    await searchHelpArticles(ctx, parseQuery(request, portalHelpQuerySchema)),
  );
});
