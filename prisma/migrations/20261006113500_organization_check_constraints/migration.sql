-- Hand-written: Prisma schema language cannot express CHECK constraints.
-- Defense-in-depth for application-level validation (src/features/organizations/schemas.ts).
ALTER TABLE "organizations"
  ADD CONSTRAINT "organizations_name_not_blank" CHECK (length(btrim("name")) > 0),
  ADD CONSTRAINT "organizations_slug_format"
    CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length("slug") BETWEEN 2 AND 48);
