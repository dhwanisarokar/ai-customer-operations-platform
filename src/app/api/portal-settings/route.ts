import { NextResponse } from "next/server";
import { portalSettingsSchema } from "@/features/portal/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { getPortalSettings, updatePortalSettings } from "@/server/portal/admin";

/** Staff: enable the customer portal of the caller's organization (`manage_portal`). */
export const GET = apiHandler(async () => {
  const ctx = await requireOrganizationContext();
  return NextResponse.json({ settings: await getPortalSettings(ctx) });
});

export const PUT = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const { enabled } = await parseJsonBody(request, portalSettingsSchema);
  return NextResponse.json({ settings: await updatePortalSettings(ctx, enabled) });
});
