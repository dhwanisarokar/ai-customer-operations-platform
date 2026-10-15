-- Sender-authentication detail for inbound email. Additive (one column on two tables, with a default).
-- `spf` / `dkim` keep holding the platform-evaluated, ALIGNED verdict; this column records how that was
-- decided (the authenticated domains and their alignment with the From domain) so a held message can be
-- reviewed with the reason in front of the reviewer.

-- AlterTable
ALTER TABLE "email_held_messages" ADD COLUMN     "authDetail" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "email_messages" ADD COLUMN     "authDetail" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "email_messages"
  ADD CONSTRAINT "email_messages_auth_detail_object" CHECK (jsonb_typeof("authDetail") = 'object' AND pg_column_size("authDetail") <= 4096);
ALTER TABLE "email_held_messages"
  ADD CONSTRAINT "email_held_auth_detail_object" CHECK (jsonb_typeof("authDetail") = 'object' AND pg_column_size("authDetail") <= 4096);
