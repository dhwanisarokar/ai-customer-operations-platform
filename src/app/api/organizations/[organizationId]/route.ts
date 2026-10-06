import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";

type Params = { organizationId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const organizationId = parseUuidParam((await params).organizationId, "Organization");
  const ctx = await requireOrganizationContext(organizationId);
  ctx.require("view_organization");
  return NextResponse.json({ organization: ctx.organization, role: ctx.membership.role });
});
