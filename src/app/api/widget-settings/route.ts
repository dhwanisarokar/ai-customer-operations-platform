import { NextResponse } from "next/server";
import { widgetSettingsInputSchema } from "@/features/widget/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { getWidgetSettings, updateWidgetSettings } from "@/server/widget/settings";

export const GET = apiHandler(async () => {
  const ctx = await requireOrganizationContext();
  return NextResponse.json({ settings: await getWidgetSettings(ctx) });
});

export const PUT = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, widgetSettingsInputSchema);
  return NextResponse.json({ settings: await updateWidgetSettings(ctx, input) });
});
