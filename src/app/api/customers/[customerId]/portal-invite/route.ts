import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { createPortalInvite } from "@/server/portal/admin";

/**
 * Staff (`manage_portal`): invite this customer to the portal. The response carries the one-time link
 * (the token is not stored in clear and cannot be shown again).
 */
export const POST = apiHandler<{ customerId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).customerId, "Customer");
  const invite = await createPortalInvite(ctx, id);
  return NextResponse.json(
    { invite: { joinPath: invite.joinPath, expiresAt: invite.expiresAt.toISOString() } },
    { status: 201 },
  );
});
