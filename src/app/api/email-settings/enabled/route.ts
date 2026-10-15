import { NextResponse } from "next/server";
import { emailEnabledSchema } from "@/features/email/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailEnabled } from "@/server/email/settings";
import { apiHandler, parseJsonBody } from "@/server/http/handler";

/** Staff (`manage_email`): turn the email channel on (verified address only) or off. */
export const PUT = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const { enabled } = await parseJsonBody(request, emailEnabledSchema);
  return NextResponse.json({ settings: await setEmailEnabled(ctx, enabled) });
});
