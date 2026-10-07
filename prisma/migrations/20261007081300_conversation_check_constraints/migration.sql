-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Defense-in-depth for rules enforced in src/server/services/conversation*.ts.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_subject_not_blank" CHECK (length(btrim("subject")) > 0),
  -- A conversation is closed exactly when it is RESOLVED.
  ADD CONSTRAINT "conversations_closed_consistent" CHECK (("status" = 'RESOLVED') = ("closedAt" IS NOT NULL)),
  ADD CONSTRAINT "conversations_preview_length" CHECK ("lastMessagePreview" IS NULL OR length("lastMessagePreview") <= 200);

ALTER TABLE "messages"
  ADD CONSTRAINT "messages_body_not_blank" CHECK (length(btrim("body")) > 0),
  -- Only USER messages carry a user id (it may become NULL if the user is deleted).
  ADD CONSTRAINT "messages_sender_user_only_for_users" CHECK ("senderType" = 'USER' OR "senderUserId" IS NULL),
  -- Customers cannot author staff-only internal notes.
  ADD CONSTRAINT "messages_internal_note_not_customer" CHECK ("messageType" <> 'INTERNAL_NOTE' OR "senderType" <> 'CUSTOMER');
