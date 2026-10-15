-- Phase 9.4: an append-only audit of operational actions on outbound emails whose outcome was in doubt. Additive only:
-- one table and one extra unique index on outbound_emails (a composite foreign-key target; "id" is already unique, so
-- it cannot reject existing rows). ASCII only (see src/migrations-ascii.test.ts).

-- CreateTable
CREATE TABLE "outbound_email_audits" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "outboundEmailId" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "previousStatus" "OutboundEmailStatus" NOT NULL,
    "newStatus" "OutboundEmailStatus" NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorUserId" UUID,
    "operatorLabel" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_email_audits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "outbound_email_audits_outboundEmailId_createdAt_idx" ON "outbound_email_audits"("outboundEmailId", "createdAt");

-- CreateIndex
CREATE INDEX "outbound_email_audits_organizationId_createdAt_idx" ON "outbound_email_audits"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_id_organizationId_key" ON "outbound_emails"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "outbound_email_audits" ADD CONSTRAINT "outbound_email_audits_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_email_audits" ADD CONSTRAINT "outbound_email_audits_outboundEmailId_organizationId_fkey" FOREIGN KEY ("outboundEmailId", "organizationId") REFERENCES "outbound_emails"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---- Rules the service also enforces; the database holds even if it is bypassed ------------------------------------
-- The ONLY audited ways out of UNKNOWN: the system re-checked with the provider (found -> SENT, authoritative
-- "not found" -> FAILED, unavailable -> still UNKNOWN), or an operator attested "not sent" with identity and reason.
-- There is deliberately no audited action that marks an unknown send SENT on someone's say-so.

ALTER TABLE "outbound_email_audits"
  ADD CONSTRAINT "outbound_email_audits_action_valid"
    CHECK ("action" IN ('recheck_found', 'recheck_not_found', 'recheck_unavailable', 'operator_confirmed_not_sent')),
  ADD CONSTRAINT "outbound_email_audits_transition_matches_action"
    CHECK (
      "previousStatus" = 'UNKNOWN' AND (
        ("action" = 'recheck_found' AND "newStatus" = 'SENT')
        OR ("action" = 'recheck_not_found' AND "newStatus" = 'FAILED')
        OR ("action" = 'recheck_unavailable' AND "newStatus" = 'UNKNOWN')
        OR ("action" = 'operator_confirmed_not_sent' AND "newStatus" = 'FAILED')
      )
    ),
  ADD CONSTRAINT "outbound_email_audits_actor_valid"
    CHECK (
      ("actorKind" = 'user' AND "actorUserId" IS NOT NULL AND "operatorLabel" IS NULL AND "action" <> 'operator_confirmed_not_sent')
      OR ("actorKind" = 'operator' AND "operatorLabel" IS NOT NULL AND "actorUserId" IS NULL AND "action" = 'operator_confirmed_not_sent')
    ),
  ADD CONSTRAINT "outbound_email_audits_operator_reason_required"
    CHECK ("actorKind" <> 'operator' OR ("reason" IS NOT NULL AND char_length(btrim("reason")) >= 10)),
  ADD CONSTRAINT "outbound_email_audits_reason_length" CHECK ("reason" IS NULL OR char_length("reason") <= 500),
  ADD CONSTRAINT "outbound_email_audits_operator_label"
    CHECK ("operatorLabel" IS NULL OR (char_length("operatorLabel") BETWEEN 1 AND 120 AND strpos("operatorLabel", chr(10)) = 0 AND strpos("operatorLabel", chr(13)) = 0));
