-- Phase 9.3A: durable outbound email foundation. Additive only: one enum, one table, and one extra unique index on
-- email_settings (a composite foreign-key target; "id" is already unique, so it cannot reject existing rows).
-- ASCII only on purpose (see src/migrations-ascii.test.ts).

-- CreateEnum
CREATE TYPE "OutboundEmailStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'RETRY_SCHEDULED', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "outbound_emails" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "emailSettingsId" UUID NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "rfcMessageId" TEXT NOT NULL,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "status" "OutboundEmailStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3),
    "lastAttemptAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "lastErrorCode" TEXT,
    "finalReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_messageId_key" ON "outbound_emails"("messageId");

-- CreateIndex
CREATE INDEX "outbound_emails_status_nextAttemptAt_idx" ON "outbound_emails"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "outbound_emails_status_leaseUntil_idx" ON "outbound_emails"("status", "leaseUntil");

-- CreateIndex
CREATE INDEX "outbound_emails_organizationId_status_idx" ON "outbound_emails"("organizationId", "status");

-- CreateIndex
CREATE INDEX "outbound_emails_organizationId_conversationId_idx" ON "outbound_emails"("organizationId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_emails_organizationId_rfcMessageId_key" ON "outbound_emails"("organizationId", "rfcMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_settings_id_organizationId_key" ON "email_settings"("id", "organizationId");

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "conversations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_messageId_conversationId_organizationId_fkey" FOREIGN KEY ("messageId", "conversationId", "organizationId") REFERENCES "messages"("id", "conversationId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_emails" ADD CONSTRAINT "outbound_emails_emailSettingsId_organizationId_fkey" FOREIGN KEY ("emailSettingsId", "organizationId") REFERENCES "email_settings"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---- Integrity rules the service also enforces; the database holds even if it is bypassed ----------------------
-- The state-vs-column rules keep a row from claiming something it cannot back up: SENT must carry a provider id and a
-- time, FAILED a time and a reason, PROCESSING a lease. (The allowed TRANSITIONS between states are enforced by
-- conditional updates in the service and tested; a CHECK cannot see the previous row.)

ALTER TABLE "outbound_emails"
  ADD CONSTRAINT "outbound_emails_sent_has_proof"
    CHECK ("status" <> 'SENT' OR ("sentAt" IS NOT NULL AND "providerMessageId" IS NOT NULL)),
  ADD CONSTRAINT "outbound_emails_failed_has_reason"
    CHECK ("status" <> 'FAILED' OR ("failedAt" IS NOT NULL AND "finalReason" IS NOT NULL)),
  ADD CONSTRAINT "outbound_emails_processing_has_lease"
    CHECK ("status" <> 'PROCESSING' OR ("leaseUntil" IS NOT NULL AND "attempts" >= 1)),
  ADD CONSTRAINT "outbound_emails_waiting_has_no_lease"
    CHECK ("status" NOT IN ('PENDING', 'RETRY_SCHEDULED') OR "leaseUntil" IS NULL),
  ADD CONSTRAINT "outbound_emails_pending_is_untried"
    CHECK ("status" <> 'PENDING' OR "attempts" = 0),
  ADD CONSTRAINT "outbound_emails_attempts_bounded" CHECK ("attempts" BETWEEN 0 AND 50),
  ADD CONSTRAINT "outbound_emails_error_code" CHECK ("lastErrorCode" IS NULL OR "lastErrorCode" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "outbound_emails_final_reason" CHECK ("finalReason" IS NULL OR "finalReason" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "outbound_emails_from_address"
    CHECK ("fromAddress" = lower("fromAddress") AND "fromAddress" ~ '^[^[:space:]<>,;"@]+@[^[:space:]<>,;"@]+$' AND char_length("fromAddress") <= 254),
  ADD CONSTRAINT "outbound_emails_to_address"
    CHECK ("toAddress" = lower("toAddress") AND "toAddress" ~ '^[^[:space:]<>,;"@]+@[^[:space:]<>,;"@]+$' AND char_length("toAddress") <= 254),
  ADD CONSTRAINT "outbound_emails_from_name"
    CHECK (char_length("fromName") BETWEEN 1 AND 80 AND strpos("fromName", chr(10)) = 0 AND strpos("fromName", chr(13)) = 0),
  ADD CONSTRAINT "outbound_emails_subject"
    CHECK (char_length("subject") <= 500 AND strpos("subject", chr(10)) = 0 AND strpos("subject", chr(13)) = 0),
  ADD CONSTRAINT "outbound_emails_message_id_shape"
    CHECK ("rfcMessageId" ~ '^<[^<>[:space:]]+>$' AND char_length("rfcMessageId") <= 512),
  ADD CONSTRAINT "outbound_emails_in_reply_to_shape"
    CHECK ("inReplyTo" IS NULL OR ("inReplyTo" ~ '^<[^<>[:space:]]+>$' AND char_length("inReplyTo") <= 512)),
  ADD CONSTRAINT "outbound_emails_references_bounded" CHECK (cardinality("references") <= 50);
