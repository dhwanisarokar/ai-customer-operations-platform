import { getDb, type Db } from "@/db/client";
import type { AiToolAuditOutcome, AiToolRiskLevel } from "@/generated/prisma/client";

/** Who ran which tool, at what risk, with what outcome. Never inputs, results or prompts. */
export const aiToolAuditRepository = {
  async record(
    entry: {
      organizationId: string;
      conversationId: string | null;
      actorUserId: string;
      toolName: string;
      riskLevel: AiToolRiskLevel;
      approvalId?: string | null;
      outcome: AiToolAuditOutcome;
      errorCode?: string | null;
    },
    db: Db = getDb(),
  ): Promise<void> {
    await db.aiToolAudit.create({
      data: {
        organizationId: entry.organizationId,
        conversationId: entry.conversationId,
        actorUserId: entry.actorUserId,
        toolName: entry.toolName,
        riskLevel: entry.riskLevel,
        approvalId: entry.approvalId ?? null,
        outcome: entry.outcome,
        errorCode: entry.errorCode ?? null,
      },
    });
  },

  list(organizationId: string, db: Db = getDb()) {
    return db.aiToolAudit.findMany({
      where: { organizationId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
};
