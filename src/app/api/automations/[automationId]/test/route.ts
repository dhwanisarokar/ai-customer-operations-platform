import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { testAutomation, testAutomationSchema } from "@/server/services/automations";

/** Dry run against sample event data. Executes nothing; needs execute_automations. */
export const POST = apiHandler<{ automationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).automationId, "Automation");
  const body = await parseJsonBody(request, testAutomationSchema);
  return NextResponse.json(await testAutomation(ctx, id, body));
});
