import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { verifyEmailAddress } from "@/server/email/settings";
import { apiHandler } from "@/server/http/handler";

/** Staff (`manage_email`): ask the provider to confirm the organization's support address. */
export const POST = apiHandler(async () => {
  const ctx = await requireOrganizationContext();
  return NextResponse.json({ settings: await verifyEmailAddress(ctx) });
});
