import { NextResponse } from "next/server";
import { createOrganizationSchema } from "@/features/organizations/schemas";
import { writeActiveOrganizationId } from "@/server/auth/active-organization";
import { requireUser } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { createOrganization, listOrganizationsForUser } from "@/server/services/organizations";

export const GET = apiHandler(async () => {
  const user = await requireUser();
  return NextResponse.json({ organizations: await listOrganizationsForUser(user) });
});

export const POST = apiHandler(async (request) => {
  const user = await requireUser();
  const input = await parseJsonBody(request, createOrganizationSchema);
  const organization = await createOrganization(user, input);
  await writeActiveOrganizationId(organization.id);
  return NextResponse.json({ organization: { ...organization, role: "OWNER" } }, { status: 201 });
});
