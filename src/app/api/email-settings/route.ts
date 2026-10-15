import { NextResponse } from "next/server";
import { emailAddressInputSchema } from "@/features/email/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { getEmailSettings, saveEmailAddress } from "@/server/email/settings";
import { apiHandler, parseJsonBody } from "@/server/http/handler";

/** Staff (`manage_email`): the caller's own organization's email settings. */
export const GET = apiHandler(async () => {
  const ctx = await requireOrganizationContext();
  return NextResponse.json({ settings: await getEmailSettings(ctx) });
});

export const PUT = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, emailAddressInputSchema);
  return NextResponse.json({ settings: await saveEmailAddress(ctx, input) });
});
