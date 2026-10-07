-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Defense-in-depth for the approval lifecycle enforced in src/server/services/ai-approvals.ts.
ALTER TABLE "ai_action_approvals"
  ADD CONSTRAINT "ai_approvals_expiry_after_creation" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "ai_approvals_approved_has_approver" CHECK (
    "status" NOT IN ('APPROVED', 'EXECUTED', 'FAILED') OR ("approvedAt" IS NOT NULL AND "approvedByUserId" IS NOT NULL)
  ),
  ADD CONSTRAINT "ai_approvals_rejected_has_rejecter" CHECK (
    "status" <> 'REJECTED' OR ("rejectedAt" IS NOT NULL AND "rejectedByUserId" IS NOT NULL)
  ),
  ADD CONSTRAINT "ai_approvals_executed_has_timestamp" CHECK ("status" <> 'EXECUTED' OR "executedAt" IS NOT NULL),
  ADD CONSTRAINT "ai_approvals_failed_has_code" CHECK ("status" <> 'FAILED' OR "failureCode" IS NOT NULL);
