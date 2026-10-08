import { NextResponse } from "next/server";
import { automationUpdateSchema } from "@/server/automation/definition";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { deleteAutomation, getAutomation, updateAutomation } from "@/server/services/automations";

type Params = { automationId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).automationId, "Automation");
  return NextResponse.json({ automation: await getAutomation(ctx, id) });
});

export const PATCH = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).automationId, "Automation");
  const changes = await parseJsonBody(request, automationUpdateSchema);
  return NextResponse.json({ automation: await updateAutomation(ctx, id, changes) });
});

export const DELETE = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).automationId, "Automation");
  await deleteAutomation(ctx, id);
  return new NextResponse(null, { status: 204 });
});
