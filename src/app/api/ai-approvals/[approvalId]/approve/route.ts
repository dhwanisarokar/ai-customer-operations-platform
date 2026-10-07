import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { approveApproval } from "@/server/services/ai-approvals";

/**
 * Approves a pending AI action and executes it in application code. No request body: the action was
 * fixed when it was requested. Authorization, tenant scope, status and expiry are all re-checked on
 * the server; the UI's button visibility is never trusted.
 */
export const POST = apiHandler<{ approvalId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).approvalId, "Approval");
  return NextResponse.json({ approval: await approveApproval(ctx, id) });
});
