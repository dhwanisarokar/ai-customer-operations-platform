import { NextResponse } from "next/server";
import { paginationSchema } from "@/lib/query-params";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseQuery } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { listExecutions } from "@/server/services/automations";

export const GET = apiHandler<{ automationId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).automationId, "Automation");
  const query = parseQuery(request, paginationSchema);
  return NextResponse.json(await listExecutions(ctx, id, query));
});
