import { NextResponse } from "next/server";
import { paginationSchema } from "@/lib/query-params";
import { automationInputSchema } from "@/server/automation/definition";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody, parseQuery } from "@/server/http/handler";
import { createAutomation, listAutomations } from "@/server/services/automations";

export const GET = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const query = parseQuery(request, paginationSchema);
  return NextResponse.json(await listAutomations(ctx, query));
});

/** The organization always comes from the session; a body with organizationId is rejected. */
export const POST = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, automationInputSchema);
  return NextResponse.json({ automation: await createAutomation(ctx, input) }, { status: 201 });
});
