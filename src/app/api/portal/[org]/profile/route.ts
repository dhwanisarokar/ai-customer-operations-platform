import { NextResponse } from "next/server";
import { portalProfileUpdateSchema } from "@/features/portal/schemas";
import { getPortalProfile, updatePortalProfile } from "@/server/portal/profile";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";
import { parsePublicBody } from "@/server/widget/http";

export const GET = portalHandler(async (_request, ctx) => {
  await limitCustomer(ctx, "read", PORTAL_LIMITS.reads);
  return NextResponse.json({ profile: await getPortalProfile(ctx) });
});

/** Only first name, last name and phone (strict schema): an `email`, `customerId`... is a 400. */
export const PATCH = portalHandler(async (request, ctx) => {
  await limitCustomer(ctx, "profile", PORTAL_LIMITS.profile);
  const input = await parsePublicBody(request, portalProfileUpdateSchema);
  return NextResponse.json({ profile: await updatePortalProfile(ctx, input) });
});
