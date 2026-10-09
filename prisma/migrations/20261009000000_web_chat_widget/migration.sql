-- AlterEnum
ALTER TYPE "ActivityActorType" ADD VALUE 'CUSTOMER';

-- AlterEnum
ALTER TYPE "ConversationChannel" ADD VALUE 'WEB_CHAT';

-- AlterEnum
ALTER TYPE "ConversationEventType" ADD VALUE 'HUMAN_REQUESTED';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "humanRequestedAt" TIMESTAMP(3),
ADD COLUMN     "visitorSessionId" UUID;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "clientMessageId" TEXT;

-- CreateTable
CREATE TABLE "widget_settings" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "publicKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL,
    "welcomeMessage" TEXT NOT NULL,
    "accentColor" TEXT,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visitor_sessions" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID,
    "tokenHash" TEXT NOT NULL,
    "visitorName" TEXT,
    "visitorEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "visitor_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "widget_settings_organizationId_key" ON "widget_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "widget_settings_publicKey_key" ON "widget_settings"("publicKey");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_tokenHash_key" ON "visitor_sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "visitor_sessions_organizationId_customerId_idx" ON "visitor_sessions"("organizationId", "customerId");

-- CreateIndex
CREATE INDEX "visitor_sessions_organizationId_expiresAt_idx" ON "visitor_sessions"("organizationId", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "visitor_sessions_id_organizationId_key" ON "visitor_sessions"("id", "organizationId");

-- CreateIndex
CREATE INDEX "conversations_organizationId_visitorSessionId_lastMessageAt_idx" ON "conversations"("organizationId", "visitorSessionId", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversationId_clientMessageId_key" ON "messages"("conversationId", "clientMessageId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_visitorSessionId_organizationId_fkey" FOREIGN KEY ("visitorSessionId", "organizationId") REFERENCES "visitor_sessions"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "widget_settings" ADD CONSTRAINT "widget_settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visitor_sessions" ADD CONSTRAINT "visitor_sessions_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

