import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { listPendingApprovals } from "@/server/services/ai-approvals";

/** Pending AI actions of one conversation (waiting for a human). Tenant-scoped; read-only. */
export const GET = apiHandler<{ conversationId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).conversationId, "Conversation");
  return NextResponse.json({ approvals: await listPendingApprovals(ctx, id) });
});
