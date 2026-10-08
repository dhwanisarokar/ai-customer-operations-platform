-- CreateEnum
CREATE TYPE "AutomationExecutionStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "automations" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT NOT NULL,
    "conditions" JSONB NOT NULL,
    "actions" JSONB NOT NULL,
    "createdByUserId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "automation_executions" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "automationId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "status" "AutomationExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "lockedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "eventData" JSONB NOT NULL,
    "definition" JSONB NOT NULL,
    "conditionResults" JSONB NOT NULL,
    "actionResults" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "automation_executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "automations_organizationId_enabled_triggerType_idx" ON "automations"("organizationId", "enabled", "triggerType");

-- CreateIndex
CREATE INDEX "automations_organizationId_createdAt_idx" ON "automations"("organizationId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "automations_id_organizationId_key" ON "automations"("id", "organizationId");

-- CreateIndex
CREATE INDEX "automation_executions_organizationId_automationId_createdAt_idx" ON "automation_executions"("organizationId", "automationId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "automation_executions_organizationId_status_idx" ON "automation_executions"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "automation_executions_organizationId_automationId_eventId_key" ON "automation_executions"("organizationId", "automationId", "eventId");

-- AddForeignKey
ALTER TABLE "automations" ADD CONSTRAINT "automations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "automation_executions" ADD CONSTRAINT "automation_executions_automationId_organizationId_fkey" FOREIGN KEY ("automationId", "organizationId") REFERENCES "automations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
