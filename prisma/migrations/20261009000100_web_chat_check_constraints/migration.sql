-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Kept separate from the enum additions (a new enum value cannot be used in the same transaction).
ALTER TABLE "widget_settings"
  ADD CONSTRAINT "widget_settings_display_name_not_blank" CHECK (length(btrim("displayName")) > 0),
  ADD CONSTRAINT "widget_settings_welcome_message_length" CHECK (length("welcomeMessage") <= 500),
  ADD CONSTRAINT "widget_settings_accent_color_format" CHECK ("accentColor" IS NULL OR "accentColor" ~ '^#[0-9a-fA-F]{6}$'),
  ADD CONSTRAINT "widget_settings_public_key_not_blank" CHECK (length("publicKey") >= 16);

ALTER TABLE "visitor_sessions"
  ADD CONSTRAINT "visitor_sessions_expiry_after_creation" CHECK ("expiresAt" > "createdAt");

-- A visitor session only ever owns web chat conversations.
ALTER TABLE "conversations"
  ADD CONSTRAINT "conversations_visitor_session_only_web_chat" CHECK ("visitorSessionId" IS NULL OR "channel" = 'WEB_CHAT');
