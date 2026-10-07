-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "ConversationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('IN_APP');

-- CreateEnum
CREATE TYPE "MessageSenderType" AS ENUM ('CUSTOMER', 'USER', 'SYSTEM', 'AI_AGENT');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('MESSAGE', 'INTERNAL_NOTE');

-- CreateEnum
CREATE TYPE "ConversationEventType" AS ENUM ('CONVERSATION_CREATED', 'SUBJECT_CHANGED', 'STATUS_CHANGED', 'PRIORITY_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'MESSAGE_SENT', 'INTERNAL_NOTE_ADDED');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "ConversationPriority" NOT NULL DEFAULT 'NORMAL',
    "channel" "ConversationChannel" NOT NULL DEFAULT 'IN_APP',
    "assignedToUserId" UUID,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "lastMessagePreview" TEXT,
    "lastMessageSenderType" "MessageSenderType",
    "lastCustomerMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "senderType" "MessageSenderType" NOT NULL,
    "senderUserId" UUID,
    "messageType" "MessageType" NOT NULL DEFAULT 'MESSAGE',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_events" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "type" "ConversationEventType" NOT NULL,
    "metadata" JSONB,
    "actorType" "ActivityActorType" NOT NULL DEFAULT 'USER',
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_read_states" (
    "conversationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "lastReadAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_read_states_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateIndex
CREATE INDEX "conversations_organizationId_status_lastMessageAt_idx" ON "conversations"("organizationId", "status", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "conversations_organizationId_lastMessageAt_idx" ON "conversations"("organizationId", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "conversations_organizationId_assignedToUserId_status_idx" ON "conversations"("organizationId", "assignedToUserId", "status");

-- CreateIndex
CREATE INDEX "conversations_organizationId_priority_lastMessageAt_idx" ON "conversations"("organizationId", "priority", "lastMessageAt" DESC);

-- CreateIndex
CREATE INDEX "conversations_organizationId_customerId_lastMessageAt_idx" ON "conversations"("organizationId", "customerId", "lastMessageAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_id_organizationId_key" ON "conversations"("id", "organizationId");

-- CreateIndex
CREATE INDEX "messages_organizationId_conversationId_createdAt_id_idx" ON "messages"("organizationId", "conversationId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "conversation_events_organizationId_conversationId_createdAt_idx" ON "conversation_events"("organizationId", "conversationId", "createdAt", "id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customerId_organizationId_fkey" FOREIGN KEY ("customerId", "organizationId") REFERENCES "customers"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assignedToUserId_organizationId_fkey" FOREIGN KEY ("assignedToUserId", "organizationId") REFERENCES "memberships"("userId", "organizationId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "conversations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_senderUserId_fkey" FOREIGN KEY ("senderUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_events" ADD CONSTRAINT "conversation_events_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "conversations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_conversationId_organizationId_fkey" FOREIGN KEY ("conversationId", "organizationId") REFERENCES "conversations"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_read_states" ADD CONSTRAINT "conversation_read_states_userId_organizationId_fkey" FOREIGN KEY ("userId", "organizationId") REFERENCES "memberships"("userId", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;
