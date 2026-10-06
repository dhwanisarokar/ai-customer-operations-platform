import { NextResponse } from "next/server";
import { addMemberSchema } from "@/features/organizations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { addMember, listMembers } from "@/server/services/memberships";

type Params = { organizationId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext(
    parseUuidParam((await params).organizationId, "Organization"),
  );
  return NextResponse.json({ members: await listMembers(ctx) });
});

export const POST = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext(
    parseUuidParam((await params).organizationId, "Organization"),
  );
  const input = await parseJsonBody(request, addMemberSchema);
  return NextResponse.json({ member: await addMember(ctx, input) }, { status: 201 });
});
