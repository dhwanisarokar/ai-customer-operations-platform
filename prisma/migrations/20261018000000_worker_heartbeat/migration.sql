-- Background worker heartbeat. Additive (one new table, no tenant data). Each worker upserts its row after
-- every maintenance pass so the web tier can report "the worker stopped" from the shared database, with no
-- new infrastructure.

-- CreateTable
CREATE TABLE "worker_heartbeats" (
    "name" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_heartbeats_pkey" PRIMARY KEY ("name")
);

ALTER TABLE "worker_heartbeats"
  ADD CONSTRAINT "worker_heartbeats_name_format" CHECK ("name" ~ '^[a-z][a-z0-9_]{0,63}$'),
  ADD CONSTRAINT "worker_heartbeats_error_code" CHECK ("lastError" IS NULL OR "lastError" ~ '^[a-z0-9_]{1,64}$');
