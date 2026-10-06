import { NextResponse } from "next/server";
import { setActiveOrganizationSchema } from "@/features/organizations/schemas";
import { writeActiveOrganizationId } from "@/server/auth/active-organization";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";

/** Switches the active organization. Membership is verified before the preference is stored. */
export const PUT = apiHandler(async (request) => {
  const { organizationId } = await parseJsonBody(request, setActiveOrganizationSchema);
  const ctx = await requireOrganizationContext(organizationId);
  await writeActiveOrganizationId(ctx.organization.id);
  return NextResponse.json({ organization: ctx.organization, role: ctx.membership.role });
});
