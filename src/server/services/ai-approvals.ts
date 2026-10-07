import type { Prisma } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import { toToolError } from "@/server/ai/tools/errors";
import { audit } from "@/server/ai/tools/audit";
import {
  defaultToolRegistry,
  resolveTool,
  type AnyTool,
  type ToolRegistry,
} from "@/server/ai/tools/registry";
import {
  APPROVAL_TTL_MS,
  MAX_PENDING_APPROVALS,
  ToolError,
  type ApprovalDto,
  type ToolExecutionContext,
  type ToolPreview,
} from "@/server/ai/tools/types";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { aiApprovalsRepository, type AiApprovalRecord } from "@/server/repositories/ai-approvals";

const log = createLogger("ai.approvals");

export function toApprovalDto(row: AiApprovalRecord): ApprovalDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    toolName: row.toolName,
    riskLevel: row.riskLevel,
    status: row.status,
    preview: row.preview as ToolPreview,
    requestedByUserId: row.requestedByUserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    failureCode: row.failureCode,
  };
}

/**
 * Stores a PENDING approval for a validated mutation request. Called by the tool runner after
 * authorization and risk policy. The input stored is the parsed tool input (no prompt text).
 * Asking for the identical change twice returns the existing pending approval.
 */
export async function requestApproval(
  ec: ToolExecutionContext,
  tool: AnyTool,
  input: unknown,
  preview: ToolPreview,
): Promise<ApprovalDto> {
  const organizationId = ec.ctx.organization.id;
  const now = new Date();
  const serialized = JSON.stringify(input);

  const pending = await aiApprovalsRepository.listPendingForTool(
    organizationId,
    ec.conversationId,
    tool.name,
    now,
  );
  const duplicate = pending.find((row) => JSON.stringify(row.input) === serialized);
  if (duplicate) return toApprovalDto(duplicate);
  if (ec.conversationId) {
    const all = await aiApprovalsRepository.listPending(organizationId, ec.conversationId, now);
    if (all.length >= MAX_PENDING_APPROVALS) {
      throw new ToolError(
        "TOOL_LIMIT_REACHED",
        "Too many actions are already waiting for approval.",
      );
    }
  }

  const created = await aiApprovalsRepository.create(organizationId, {
    conversationId: ec.conversationId,
    requestedByUserId: ec.ctx.user.id,
    toolName: tool.name,
    input: input as Prisma.InputJsonValue,
    preview: preview as unknown as Prisma.InputJsonValue,
    riskLevel: tool.riskLevel,
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
  });
  log.info(
    { organizationId, approvalId: created.id, toolName: tool.name, actorId: ec.ctx.user.id },
    "ai action approval requested",
  );
  return toApprovalDto(created);
}

/** Pending, unexpired approvals of one conversation (stale ones are marked EXPIRED first). */
export async function listPendingApprovals(
  ctx: OrganizationContext,
  conversationId: string,
): Promise<ApprovalDto[]> {
  ctx.require("view_conversations");
  const now = new Date();
  await aiApprovalsRepository.expireStale(ctx.organization.id, now);
  const rows = await aiApprovalsRepository.listPending(ctx.organization.id, conversationId, now);
  return rows.map(toApprovalDto);
}

async function loadApproval(ctx: OrganizationContext, approvalId: string) {
  // Tenant-scoped: another organization's approval is indistinguishable from a missing one.
  const row = await aiApprovalsRepository.findById(ctx.organization.id, approvalId);
  if (!row) throw new NotFoundError("Approval not found");
  return row;
}

async function failIfExpired(ctx: OrganizationContext, row: AiApprovalRecord, now: Date) {
  if (row.status === "EXPIRED" || (row.status === "PENDING" && row.expiresAt <= now)) {
    await aiApprovalsRepository.expireStale(ctx.organization.id, now, undefined, row.id);
    throw new ToolError("APPROVAL_EXPIRED", "This approval has expired. Ask the AI again.");
  }
}

/**
 * Approve = authorize again, claim the approval atomically, then execute in application code.
 *
 * Every check is server-side and independent of the UI: authentication and membership come from
 * the context; the approver must hold the tool's permission; the approval must belong to this
 * organization, be PENDING and unexpired. The PENDING -> APPROVED claim is a guarded update, so a
 * double click or two approvers cannot execute twice. The mutation runs with the APPROVER's
 * context, so the existing services re-check that person's permissions and attribute the change
 * to them. Nothing is retried automatically.
 */
export async function approveApproval(
  ctx: OrganizationContext,
  approvalId: string,
  registry: ToolRegistry = defaultToolRegistry,
): Promise<ApprovalDto> {
  const organizationId = ctx.organization.id;
  const row = await loadApproval(ctx, approvalId);
  const tool = resolveTool(row.toolName, registry);
  ctx.require(tool.requiredPermission);

  const now = new Date();
  await failIfExpired(ctx, row, now);

  const won = await aiApprovalsRepository.claimApproval(organizationId, row.id, ctx.user.id, now);
  if (!won) {
    // Lost the race, or it was already approved/rejected/executed.
    const latest = await loadApproval(ctx, approvalId);
    await failIfExpired(ctx, latest, now);
    throw new ConflictError("This action has already been handled.");
  }

  const ec: ToolExecutionContext = { ctx, conversationId: row.conversationId };
  const audited = {
    organizationId,
    conversationId: row.conversationId,
    actorUserId: ctx.user.id,
    toolName: tool.name,
    riskLevel: tool.riskLevel,
    approvalId: row.id,
  };

  try {
    // Re-validate the stored input: the execution path never trusts what was stored blindly.
    const input = tool.inputSchema.parse(row.input);
    await tool.execute(ec, input);
    await aiApprovalsRepository.finish(organizationId, row.id, { status: "EXECUTED" }, new Date());
    await audit(ec, { ...audited, outcome: "SUCCESS" });
    log.info({ organizationId, approvalId: row.id, toolName: tool.name }, "ai action executed");
  } catch (error) {
    const toolError = toToolError(error, { toolName: tool.name, organizationId });
    await aiApprovalsRepository.finish(
      organizationId,
      row.id,
      { status: "FAILED", failureCode: toolError.toolCode },
      new Date(),
    );
    await audit(ec, { ...audited, outcome: "FAILURE", errorCode: toolError.toolCode });
  }

  return toApprovalDto(await loadApproval(ctx, approvalId));
}

/** Reject = the requester or anyone allowed to run the tool may decline a still-pending action. */
export async function rejectApproval(
  ctx: OrganizationContext,
  approvalId: string,
  registry: ToolRegistry = defaultToolRegistry,
): Promise<ApprovalDto> {
  const organizationId = ctx.organization.id;
  const row = await loadApproval(ctx, approvalId);
  const tool = resolveTool(row.toolName, registry);
  if (row.requestedByUserId !== ctx.user.id) ctx.require(tool.requiredPermission);

  const now = new Date();
  await failIfExpired(ctx, row, now);
  const won = await aiApprovalsRepository.claimRejection(organizationId, row.id, ctx.user.id, now);
  if (!won) throw new ConflictError("This action has already been handled.");

  await audit(
    { ctx, conversationId: row.conversationId },
    {
      organizationId,
      conversationId: row.conversationId,
      actorUserId: ctx.user.id,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      approvalId: row.id,
      outcome: "DENIED",
      errorCode: "REJECTED_BY_USER",
    },
  );
  return toApprovalDto(await loadApproval(ctx, approvalId));
}
