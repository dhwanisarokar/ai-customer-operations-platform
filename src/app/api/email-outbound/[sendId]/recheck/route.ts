import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { recheckUnknown } from "@/server/email/outbound-ops";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";

type Params = { sendId: string };

/**
 * Ask the mail PROVIDER what happened to an email whose outcome is unknown, and record what it answers (`manage_email`,
 * the caller's organization). The request has no body: the caller cannot choose the outcome. It never resends and never
 * marks anything sent on the caller's say-so. 409 when the provider cannot be asked, the send is not unknown, or the last
 * attempt is too recent to be sure.
 */
export const POST = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).sendId, "Email");
  return NextResponse.json(await recheckUnknown(ctx, id));
});
