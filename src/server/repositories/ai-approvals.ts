import { getDb, type Db } from "@/db/client";
import type { AiApprovalStatus, AiToolRiskLevel, Prisma } from "@/generated/prisma/client";

const approvalSelect = {
  id: true,
  conversationId: true,
  requestedByUserId: true,
  toolName: true,
  input: true,
  preview: true,
  riskLevel: true,
  status: true,
  createdAt: true,
  expiresAt: true,
  approvedAt: true,
  approvedByUserId: true,
  rejectedAt: true,
  rejectedByUserId: true,
  executedAt: true,
  failureCode: true,
} satisfies Prisma.AiActionApprovalSelect;

export type AiApprovalRecord = Prisma.AiActionApprovalGetPayload<{
  select: typeof approvalSelect;
}>;

/**
 * Every query is scoped by organizationId. State changes are guarded updates
 * (`updateMany ... WHERE status = <expected>`), so two concurrent requests can never both win a
 * transition: exactly one gets `count === 1`.
 */
export const aiApprovalsRepository = {
  create(
    organizationId: string,
    data: {
      conversationId: string | null;
      requestedByUserId: string;
      toolName: string;
      input: Prisma.InputJsonValue;
      preview: Prisma.InputJsonValue;
      riskLevel: AiToolRiskLevel;
      expiresAt: Date;
    },
    db: Db = getDb(),
  ): Promise<AiApprovalRecord> {
    return db.aiActionApproval.create({
      data: { organizationId, ...data },
      select: approvalSelect,
    });
  },

  findById(organizationId: string, id: string, db: Db = getDb()): Promise<AiApprovalRecord | null> {
    return db.aiActionApproval.findFirst({ where: { id, organizationId }, select: approvalSelect });
  },

  listPending(
    organizationId: string,
    conversationId: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<AiApprovalRecord[]> {
    return db.aiActionApproval.findMany({
      where: { organizationId, conversationId, status: "PENDING", expiresAt: { gt: now } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: approvalSelect,
    });
  },

  /** Pending (and still valid) approvals of one tool in one conversation, for de-duplication. */
  listPendingForTool(
    organizationId: string,
    conversationId: string | null,
    toolName: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<AiApprovalRecord[]> {
    return db.aiActionApproval.findMany({
      where: {
        organizationId,
        conversationId,
        toolName,
        status: "PENDING",
        expiresAt: { gt: now },
      },
      select: approvalSelect,
    });
  },

  /** Marks stale PENDING approvals EXPIRED. Returns how many changed. */
  async expireStale(
    organizationId: string,
    now: Date,
    db: Db = getDb(),
    id?: string,
  ): Promise<number> {
    const result = await db.aiActionApproval.updateMany({
      where: { organizationId, status: "PENDING", expiresAt: { lte: now }, ...(id ? { id } : {}) },
      data: { status: "EXPIRED" },
    });
    return result.count;
  },

  /** PENDING -> APPROVED, only if still pending and unexpired. True when this call won. */
  async claimApproval(
    organizationId: string,
    id: string,
    approverId: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.aiActionApproval.updateMany({
      where: { id, organizationId, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "APPROVED", approvedAt: now, approvedByUserId: approverId },
    });
    return result.count === 1;
  },

  /** PENDING -> REJECTED, only if still pending and unexpired. True when this call won. */
  async claimRejection(
    organizationId: string,
    id: string,
    rejecterId: string,
    now: Date,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.aiActionApproval.updateMany({
      where: { id, organizationId, status: "PENDING", expiresAt: { gt: now } },
      data: { status: "REJECTED", rejectedAt: now, rejectedByUserId: rejecterId },
    });
    return result.count === 1;
  },

  /** APPROVED -> EXECUTED | FAILED. Never touches any other state. */
  async finish(
    organizationId: string,
    id: string,
    outcome: { status: Extract<AiApprovalStatus, "EXECUTED" | "FAILED">; failureCode?: string },
    now: Date,
    db: Db = getDb(),
  ): Promise<void> {
    await db.aiActionApproval.updateMany({
      where: { id, organizationId, status: "APPROVED" },
      data:
        outcome.status === "EXECUTED"
          ? { status: "EXECUTED", executedAt: now }
          : { status: "FAILED", failureCode: outcome.failureCode ?? "EXECUTION_FAILED" },
    });
  },
};
