-- CreateEnum
CREATE TYPE "EmailSettingsStatus" AS ENUM ('UNCONFIGURED', 'PENDING_VERIFICATION', 'ACTIVE', 'FAILED');

-- AlterEnum
ALTER TYPE "ConversationChannel" ADD VALUE 'EMAIL';

-- CreateTable
CREATE TABLE "email_settings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "status" "EmailSettingsStatus" NOT NULL DEFAULT 'UNCONFIGURED',
    "statusDetail" TEXT,
    "statusCheckedAt" TIMESTAMP(3),
    "localPart" TEXT NOT NULL,
    "supportAddress" TEXT NOT NULL,
    "fromName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_settings_organizationId_key" ON "email_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "email_settings_supportAddress_key" ON "email_settings"("supportAddress");

-- AddForeignKey
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Integrity rules (the application enforces the same; these hold even if code is bypassed).
-- Email processing is only ever ON for an address the provider has verified.
ALTER TABLE "email_settings"
  ADD CONSTRAINT "email_settings_enabled_requires_active" CHECK (NOT "enabled" OR "status" = 'ACTIVE');

-- The routing key is a lowercase address whose local part is the stored local part.
ALTER TABLE "email_settings"
  ADD CONSTRAINT "email_settings_local_part_format"
    CHECK ("localPart" ~ '^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$'),
  ADD CONSTRAINT "email_settings_address_normalized"
    CHECK ("supportAddress" = lower("supportAddress")
           AND split_part("supportAddress", '@', 1) = "localPart"
           AND "supportAddress" ~ '^[^@\s]+@[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
           AND char_length("supportAddress") <= 254);

-- A display name goes into a mail header: never blank, bounded, no control characters (header injection).
ALTER TABLE "email_settings"
  ADD CONSTRAINT "email_settings_from_name_valid"
    CHECK (btrim("fromName") <> '' AND char_length("fromName") <= 80 AND "fromName" !~ '[[:cntrl:]]');

ALTER TABLE "email_settings"
  ADD CONSTRAINT "email_settings_status_detail_code"
    CHECK ("statusDetail" IS NULL OR "statusDetail" ~ '^[a-z0-9_]{1,64}$');
