import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { getExecution } from "@/server/services/automations";

export const GET = apiHandler<{ automationId: string; executionId: string }>(
  async (_request, { params }) => {
    const ctx = await requireOrganizationContext();
    const resolved = await params;
    const automationId = parseUuidParam(resolved.automationId, "Automation");
    const executionId = parseUuidParam(resolved.executionId, "Execution");
    return NextResponse.json({ execution: await getExecution(ctx, automationId, executionId) });
  },
);
