import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { getPortalAccess, revokePortalAccess } from "@/server/portal/admin";

/** Staff (`manage_portal`): does this customer have portal access, is an invitation pending? */
export const GET = apiHandler<{ customerId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).customerId, "Customer");
  return NextResponse.json({ access: await getPortalAccess(ctx, id) });
});

/** Staff (`manage_portal`): remove the link and cancel pending invitations. */
export const DELETE = apiHandler<{ customerId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).customerId, "Customer");
  return NextResponse.json(await revokePortalAccess(ctx, id));
});
