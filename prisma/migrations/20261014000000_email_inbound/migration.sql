-- Phase 9.2: inbound email. Additive only: three new tables, three enums and one extra unique index on
-- messages (a composite foreign-key target; "id" is already unique, so it cannot reject existing rows).

-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "EmailHoldReason" AS ENUM ('UNAUTHENTICATED_SENDER', 'ARCHIVED_CUSTOMER', 'AMBIGUOUS_THREAD', 'THREAD_SENDER_MISMATCH');

-- CreateEnum
CREATE TYPE "EmailEventOutcome" AS ENUM ('PROCESSED', 'HELD', 'IGNORED', 'DUPLICATE');

-- CreateTable
CREATE TABLE "email_messages" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "direction" "EmailDirection" NOT NULL,
    "providerMessageId" TEXT,
    "rfcMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "subject" TEXT NOT NULL,
    "spf" TEXT NOT NULL,
    "dkim" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_webhook_events" (
    "id" UUID NOT NULL,
    "replayKey" TEXT NOT NULL,
    "outcome" "EmailEventOutcome" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_held_messages" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "reason" "EmailHoldReason" NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "rfcMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "spf" TEXT NOT NULL,
    "dkim" TEXT NOT NULL,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "email_held_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_messageId_key" ON "email_messages"("messageId");

-- CreateIndex
CREATE INDEX "email_messages_organizationId_rfcMessageId_idx" ON "email_messages"("organizationId", "rfcMessageId");

-- CreateIndex
CREATE INDEX "email_messages_organizationId_conversationId_idx" ON "email_messages"("organizationId", "conversationId");

-- CreateIndex
CREATE INDEX "email_messages_organizationId_direction_fromAddress_created_idx" ON "email_messages"("organizationId", "direction", "fromAddress", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_messages_organizationId_providerMessageId_key" ON "email_messages"("organizationId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "email_webhook_events_replayKey_key" ON "email_webhook_events"("replayKey");

-- CreateIndex
CREATE INDEX "email_webhook_events_createdAt_idx" ON "email_webhook_events"("createdAt");

-- CreateIndex
CREATE INDEX "email_held_messages_organizationId_resolvedAt_createdAt_idx" ON "email_held_messages"("organizationId", "resolvedAt", "createdAt");

-- CreateIndex
CREATE INDEX "email_held_messages_organizationId_fromAddress_createdAt_idx" ON "email_held_messages"("organizationId", "fromAddress", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_held_messages_organizationId_providerMessageId_key" ON "email_held_messages"("organizationId", "providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "messages_id_conversationId_organizationId_key" ON "messages"("id", "conversationId", "organizationId");

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "conversations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_messages" ADD CONSTRAINT "email_messages_messageId_conversationId_organizationId_fkey" FOREIGN KEY ("messageId", "conversationId", "organizationId") REFERENCES "messages"("id", "conversationId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_held_messages" ADD CONSTRAINT "email_held_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---- Integrity rules the services also enforce; the database holds even if they are bypassed -----------

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_inbound_has_provider_id"
    CHECK ("direction" <> 'INBOUND' OR "providerMessageId" IS NOT NULL),
  ADD CONSTRAINT "email_messages_from_normalized"
    CHECK ("fromAddress" = lower("fromAddress") AND char_length("fromAddress") BETWEEN 3 AND 254),
  ADD CONSTRAINT "email_messages_verdicts_valid"
    CHECK ("spf" IN ('pass', 'fail', 'none') AND "dkim" IN ('pass', 'fail', 'none')),
  ADD CONSTRAINT "email_messages_subject_length" CHECK (char_length("subject") <= 500),
  ADD CONSTRAINT "email_messages_header_ids_valid"
    CHECK (
      ("rfcMessageId" IS NULL OR
        ("rfcMessageId" ~ '^<[^<>[:space:][:cntrl:]]+>$' AND char_length("rfcMessageId") <= 512))
      AND ("inReplyTo" IS NULL OR
        ("inReplyTo" ~ '^<[^<>[:space:][:cntrl:]]+>$' AND char_length("inReplyTo") <= 512))
    ),
  ADD CONSTRAINT "email_messages_bounded_lists"
    CHECK (
      cardinality("references") <= 50 AND cardinality("toAddresses") <= 50
      AND cardinality("ccAddresses") <= 50
    );

ALTER TABLE "email_held_messages"
  ADD CONSTRAINT "email_held_from_normalized"
    CHECK ("fromAddress" = lower("fromAddress") AND char_length("fromAddress") BETWEEN 3 AND 254),
  ADD CONSTRAINT "email_held_verdicts_valid"
    CHECK ("spf" IN ('pass', 'fail', 'none') AND "dkim" IN ('pass', 'fail', 'none')),
  ADD CONSTRAINT "email_held_subject_length" CHECK (char_length("subject") <= 500),
  ADD CONSTRAINT "email_held_body_length" CHECK (char_length("body") <= 10000),
  ADD CONSTRAINT "email_held_bounded_lists"
    CHECK (
      cardinality("references") <= 50 AND cardinality("toAddresses") <= 50
      AND cardinality("ccAddresses") <= 50
    );

ALTER TABLE "email_webhook_events"
  ADD CONSTRAINT "email_webhook_events_reason_code"
    CHECK ("reason" IS NULL OR "reason" ~ '^[a-z0-9_]{1,64}$'),
  ADD CONSTRAINT "email_webhook_events_replay_key_length"
    CHECK (char_length("replayKey") BETWEEN 1 AND 300);
