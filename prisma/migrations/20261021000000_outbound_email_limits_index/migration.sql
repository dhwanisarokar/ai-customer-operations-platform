-- Phase 9.6: an index for the outbound abuse limits (a tenant's sends in a recent window, see
-- src/server/email/outbound-limits.ts). Additive only: no table, column or row changes. ASCII only
-- (see src/migrations-ascii.test.ts). It builds under a short write lock on outbound_emails; the table is small
-- (one row per outbound reply) and the build is quick, but apply it outside peak hours.

-- CreateIndex
CREATE INDEX "outbound_emails_organizationId_createdAt_idx" ON "outbound_emails"("organizationId", "createdAt");
