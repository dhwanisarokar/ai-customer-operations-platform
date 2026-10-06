import { NextResponse } from "next/server";
import { transferOwnershipSchema } from "@/features/organizations/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { transferOwnership } from "@/server/services/memberships";

type Params = { organizationId: string };

export const POST = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext(
    parseUuidParam((await params).organizationId, "Organization"),
  );
  const { userId } = await parseJsonBody(request, transferOwnershipSchema);
  await transferOwnership(ctx, userId);
  return NextResponse.json({ ok: true });
});
