-- Explicit handling mode (AI | HUMAN) for conversations. Additive only.
CREATE TYPE "ConversationHandlingMode" AS ENUM ('AI', 'HUMAN');

ALTER TYPE "ConversationEventType" ADD VALUE 'HANDLING_MODE_CHANGED';

-- Every conversation starts as HUMAN (no automatic replies): existing behavior for in-app conversations.
ALTER TABLE "conversations" ADD COLUMN "handlingMode" "ConversationHandlingMode" NOT NULL DEFAULT 'HUMAN';

-- Keep web chats that are being answered by the AI today in AI mode: customer AI enabled for the
-- organization, nobody asked for a person and nobody is assigned.
UPDATE "conversations" c
SET "handlingMode" = 'AI'
FROM "widget_settings" w
WHERE w."organizationId" = c."organizationId"
  AND w."aiRepliesEnabled" = true
  AND c."channel" = 'WEB_CHAT'
  AND c."humanRequestedAt" IS NULL
  AND c."assignedToUserId" IS NULL;
