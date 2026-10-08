import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { setAutomationEnabled } from "@/server/services/automations";

export const POST = apiHandler<{ automationId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).automationId, "Automation");
  return NextResponse.json({ automation: await setAutomationEnabled(ctx, id, false) });
});
