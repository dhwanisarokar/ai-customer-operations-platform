import { NextResponse } from "next/server";
import { changeRoleSchema } from "@/features/organizations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { changeMemberRole, removeMember } from "@/server/services/memberships";

type Params = { organizationId: string; userId: string };

async function resolve(params: Promise<Params>) {
  const { organizationId, userId } = await params;
  const ctx = await requireOrganizationContext(parseUuidParam(organizationId, "Organization"));
  return { ctx, userId: parseUuidParam(userId, "Member") };
}

export const PATCH = apiHandler<Params>(async (request, { params }) => {
  const { ctx, userId } = await resolve(params);
  const input = await parseJsonBody(request, changeRoleSchema);
  return NextResponse.json({ member: await changeMemberRole(ctx, userId, input) });
});

export const DELETE = apiHandler<Params>(async (_request, { params }) => {
  const { ctx, userId } = await resolve(params);
  await removeMember(ctx, userId);
  return new NextResponse(null, { status: 204 });
});
