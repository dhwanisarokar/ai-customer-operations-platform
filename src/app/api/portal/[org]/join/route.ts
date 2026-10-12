import { NextResponse } from "next/server";
import { z } from "zod";
import { apiHandler } from "@/server/http/handler";
import { enforceRateLimit } from "@/server/rate-limit";
import { requirePortalIdentity } from "@/server/portal/context";
import { redeemPortalInvite } from "@/server/portal/link";
import { PORTAL_LIMITS } from "@/server/portal/route";
import { parsePublicBody } from "@/server/widget/http";

const joinSchema = z.object({ token: z.string().min(20).max(200) }).strict();

/**
 * Links the signed-in identity to the customer a staff member invited. Needs the invitation token AND a
 * verified identity email equal to the customer's email (see `redeemPortalInvite`). The body carries no
 * customer or organization id.
 */
export const POST = apiHandler<{ org: string }>(async (request, { params }) => {
  const { org } = await params;
  const { user, organization } = await requirePortalIdentity(org);
  await enforceRateLimit(`portal-join:${organization.id}:${user.id}`, PORTAL_LIMITS.join);
  const { token } = await parsePublicBody(request, joinSchema);
  const result = await redeemPortalInvite({ user, organizationId: organization.id, token });
  return NextResponse.json({ linked: true, alreadyLinked: result.alreadyLinked });
});
