-- Customer-facing AI replies for the web chat widget (opt-in, off by default). Additive only.
ALTER TABLE "widget_settings" ADD COLUMN "aiRepliesEnabled" BOOLEAN NOT NULL DEFAULT false;
