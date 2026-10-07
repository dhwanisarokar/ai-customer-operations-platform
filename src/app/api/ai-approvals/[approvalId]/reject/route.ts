import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { rejectApproval } from "@/server/services/ai-approvals";

/** Rejects a pending AI action. Nothing is executed. */
export const POST = apiHandler<{ approvalId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).approvalId, "Approval");
  return NextResponse.json({ approval: await rejectApproval(ctx, id) });
});
