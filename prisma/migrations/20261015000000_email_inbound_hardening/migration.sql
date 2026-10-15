-- Phase 9.2 audit hardening. Additive (CHECK constraints only). The services already clean these values before
-- storing them; the database now refuses a control character or a bidirectional override even if a future
-- code path forgets to. Without this, such characters could later be copied into an outbound mail header or
-- used to disguise a name or subject in the Inbox. Explicit code-point ranges are used instead of
-- [[:cntrl:]] because that class is locale-dependent for non-ASCII characters. The direction MARKS
-- (U+200E/U+200F) are deliberately allowed, so genuine right-to-left text is stored.
--
-- This file is pure ASCII on purpose: the code points are written as \uXXXX escapes (interpreted by the
-- PostgreSQL regex engine), never as literal characters, so no editor, terminal or client encoding can change it.

-- These rules name non-ASCII code points (C1 controls, line separators, bidi overrides), which PostgreSQL can only
-- express in a UTF8 database. Fail early with a clear message instead of a cryptic encoding error from the regex.
DO $$
BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'This migration needs a UTF8 database (server_encoding is %). Create the database with ENCODING UTF8 (this also applies to the Prisma shadow database).', current_setting('server_encoding');
  END IF;
END
$$;

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_from_name_clean"
    CHECK ("fromName" IS NULL OR "fromName" !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "email_messages_from_address_shape"
    CHECK ("fromAddress" ~ '^[^[:space:]\u0001-\u001f\u007f<>,;"@]+@[^[:space:]\u0001-\u001f\u007f<>,;"@]+$'),
  ADD CONSTRAINT "email_messages_provider_id_clean"
    CHECK ("providerMessageId" IS NULL OR "providerMessageId" !~ '[\u0001-\u001f\u007f]'),
  ADD CONSTRAINT "email_messages_subject_clean"
    CHECK ("subject" !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]');

ALTER TABLE "email_held_messages"
  ADD CONSTRAINT "email_held_from_name_clean"
    CHECK ("fromName" IS NULL OR "fromName" !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]'),
  ADD CONSTRAINT "email_held_from_address_shape"
    CHECK ("fromAddress" ~ '^[^[:space:]\u0001-\u001f\u007f<>,;"@]+@[^[:space:]\u0001-\u001f\u007f<>,;"@]+$'),
  ADD CONSTRAINT "email_held_provider_id_clean"
    CHECK ("providerMessageId" !~ '[\u0001-\u001f\u007f]'),
  ADD CONSTRAINT "email_held_subject_clean"
    CHECK ("subject" !~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]');
