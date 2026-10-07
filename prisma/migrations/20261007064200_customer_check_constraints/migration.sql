-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Defense-in-depth for application-level normalization/validation (src/features/customers).
ALTER TABLE "customers"
  ADD CONSTRAINT "customers_first_name_not_blank" CHECK (length(btrim("firstName")) > 0),
  ADD CONSTRAINT "customers_email_normalized" CHECK ("email" IS NULL OR ("email" = lower(btrim("email")) AND "email" <> '')),
  ADD CONSTRAINT "customers_phone_normalized" CHECK ("phone" IS NULL OR "phone" ~ '^\+?[0-9]{5,15}$'),
  -- A customer is archived exactly when archivedAt is set.
  ADD CONSTRAINT "customers_archive_consistent" CHECK (("status" = 'ARCHIVED') = ("archivedAt" IS NOT NULL));

-- normalizedName is deliberately not checked against lower("name"): PostgreSQL's lower() and
-- JavaScript's toLowerCase() disagree for some non-ASCII text depending on the database locale.
ALTER TABLE "tags"
  ADD CONSTRAINT "tags_name_not_blank" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "tags_normalized_name_not_blank" CHECK (length(btrim("normalizedName")) > 0);

ALTER TABLE "customer_notes"
  ADD CONSTRAINT "customer_notes_content_not_blank" CHECK (length(btrim("content")) > 0);

ALTER TABLE "customer_activities"
  ADD CONSTRAINT "customer_activities_title_not_blank" CHECK (length(btrim("title")) > 0);
