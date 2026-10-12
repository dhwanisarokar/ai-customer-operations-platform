import { NextResponse } from "next/server";
import { getPortalSummary } from "@/server/portal/conversations";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";

export const GET = portalHandler(async (_request, ctx) => {
  await limitCustomer(ctx, "read", PORTAL_LIMITS.reads);
  return NextResponse.json({
    organization: { name: ctx.organization.name, slug: ctx.organization.slug },
    ...(await getPortalSummary(ctx)),
  });
});
