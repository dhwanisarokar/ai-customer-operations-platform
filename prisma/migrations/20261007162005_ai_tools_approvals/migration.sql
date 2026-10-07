-- CreateEnum
CREATE TYPE "AiToolRiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "AiApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'EXECUTED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiToolAuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED', 'APPROVAL_REQUESTED');

-- CreateTable
CREATE TABLE "ai_action_approvals" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "conversationId" UUID,
    "requestedByUserId" UUID NOT NULL,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "riskLevel" "AiToolRiskLevel" NOT NULL,
    "status" "AiApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" UUID,
    "rejectedAt" TIMESTAMP(3),
    "rejectedByUserId" UUID,
    "executedAt" TIMESTAMP(3),
    "failureCode" TEXT,

    CONSTRAINT "ai_action_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_tool_audits" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "conversationId" UUID,
    "actorUserId" UUID NOT NULL,
    "toolName" TEXT NOT NULL,
    "riskLevel" "AiToolRiskLevel" NOT NULL,
    "approvalId" UUID,
    "outcome" "AiToolAuditOutcome" NOT NULL,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_tool_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_action_approvals_organizationId_conversationId_status_cr_idx" ON "ai_action_approvals"("organizationId", "conversationId", "status", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ai_action_approvals_organizationId_status_expiresAt_idx" ON "ai_action_approvals"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "ai_tool_audits_organizationId_createdAt_idx" ON "ai_tool_audits"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ai_tool_audits_organizationId_approvalId_idx" ON "ai_tool_audits"("organizationId", "approvalId");

-- AddForeignKey
ALTER TABLE "ai_action_approvals" ADD CONSTRAINT "ai_action_approvals_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_action_approvals" ADD CONSTRAINT "ai_action_approvals_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "conversations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_tool_audits" ADD CONSTRAINT "ai_tool_audits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
