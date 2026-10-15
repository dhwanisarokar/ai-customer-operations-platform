-- Phase 9.7: separate the retry BUDGET from the ownership counter. "attempts" is incremented by every claim and every
-- takeover (it fences stale workers); "retries" counts retries actually scheduled after a provider call, so recovery
-- checks alone can never exhaust the budget. Additive: one column with a default and a bound. ASCII only (see
-- src/migrations-ascii.test.ts). Existing rows (none in a deployment that has not sent email yet) get a conservative value.

-- AlterTable
ALTER TABLE "outbound_emails" ADD COLUMN "retries" INTEGER NOT NULL DEFAULT 0;

UPDATE "outbound_emails" SET "retries" = LEAST(50, CASE "status"
  WHEN 'RETRY_SCHEDULED' THEN "attempts"
  WHEN 'PROCESSING' THEN GREATEST("attempts" - 1, 0)
  ELSE 0 END);

ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_retries_bounded" CHECK ("retries" BETWEEN 0 AND 50);
