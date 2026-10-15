-- Durable domain events: the transactional outbox. Additive (one new table). A change and its events commit
-- together; the events are published after the commit and retried by a reconciler if that did not happen.

-- CreateTable
CREATE TABLE "domain_event_outbox" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "actorUserId" UUID,
    "data" JSONB NOT NULL,
    "causedByAutomation" BOOLEAN NOT NULL DEFAULT false,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "lastError" TEXT,

    CONSTRAINT "domain_event_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "domain_event_outbox_publishedAt_leaseUntil_idx" ON "domain_event_outbox"("publishedAt", "leaseUntil");

-- CreateIndex
CREATE INDEX "domain_event_outbox_organizationId_createdAt_idx" ON "domain_event_outbox"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "domain_event_outbox" ADD CONSTRAINT "domain_event_outbox_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity rules (the service enforces them too)
ALTER TABLE "domain_event_outbox"
  ADD CONSTRAINT "domain_event_outbox_type_format" CHECK ("type" ~ '^[a-z][a-z0-9_.]{0,63}$'),
  ADD CONSTRAINT "domain_event_outbox_attempts_valid" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "domain_event_outbox_error_code" CHECK ("lastError" IS NULL OR "lastError" ~ '^[a-z0-9_]{1,64}$');
-- Deliberately NO "publishedAt >= createdAt" check: createdAt is the database clock and publishedAt the
-- application clock, so ordinary clock skew would make a legitimate publish fail.
