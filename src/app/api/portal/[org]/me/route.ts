import { NextResponse } from "next/server";
import { apiHandler } from "@/server/http/handler";
import { requirePortalIdentity } from "@/server/portal/context";
import { getPortalProfile } from "@/server/portal/profile";

/**
 * Who am I in this portal? Works before an account is linked (so the page can explain what to do). The
 * organization is only a selector: an unknown or disabled portal is a 404, a signed-out caller a 401.
 */
export const GET = apiHandler<{ org: string }>(async (_request, { params }) => {
  const { org } = await params;
  const { organization, linked } = await requirePortalIdentity(org);
  if (!linked) {
    return NextResponse.json({
      organization: { name: organization.name, slug: organization.slug },
      linked: false,
    });
  }
  // Linked: resolve the full context (customer must be active) and return a minimal profile.
  const { requirePortalContext } = await import("@/server/portal/context");
  const ctx = await requirePortalContext(org);
  const profile = await getPortalProfile(ctx);
  return NextResponse.json({
    organization: { name: organization.name, slug: organization.slug },
    linked: true,
    customer: { firstName: profile.firstName, lastName: profile.lastName },
  });
});
