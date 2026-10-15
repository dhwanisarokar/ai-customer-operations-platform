import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import { getTrigger } from "@/server/automation/triggers";
import { metrics } from "@/server/observability/metrics";
import { publishForDomainEvent } from "@/server/realtime/domain";
import {
  domainEventOutboxRepository,
  type OutboxRow,
} from "@/server/repositories/domain-event-outbox";
import { dispatchEventStrict, isCausedByAutomation } from "./bus";
import type { DomainEvent, EventDataMap } from "./types";
import type { TriggerName } from "@/server/automation/catalog";

const log = createLogger("events.outbox");

/**
 * Durable domain events (transactional outbox).
 *
 *   1. In the transaction of a change:  `recordDomainEvent(tx, ...)`   (the event commits WITH the change)
 *   2. After the commit:                `publishRecordedEvents(events)` (realtime hint + automations; marks published)
 *   3. If 2 never happened (crash, queue down): `reconcileOutbox()` re-publishes with the SAME event id.
 *
 * Why this cannot run an automation twice: the automation engine creates one execution per (automation, event
 * id) under a unique key, so every re-publication of the same event is a no-op, except that on a REDELIVERY an
 * execution that was recorded but never queued is queued again (the queue and the worker are idempotent).
 * Realtime hints are idempotent by nature (a client refetches).
 *
 * Event content: the outbox stores ids and enum values only. The text of a message (`message.created.body`,
 * used by automation conditions) is read back from `messages` when publishing, so message content is never
 * duplicated into this table.
 */

/** The request that recorded an event owns it for this long; after that a reconciler may take it over. */
export const OUTBOX_INITIAL_LEASE_MS = 30_000;
/** How long a reconciler owns a claimed event while it publishes it. */
export const OUTBOX_RECONCILE_LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export type RecordedEvent<T extends TriggerName = TriggerName> = DomainEvent<T> & {
  /** Present on the in-memory copy so publishing right after the commit needs no reload. */
  recorded: true;
};

/** Text-bearing fields that must not be copied into the outbox. */
function storable(type: string, data: Record<string, unknown>): Record<string, unknown> {
  if (type !== "message.created") return data;
  const rest = { ...data };
  delete rest.body;
  return rest;
}

/** Records an event in the caller's transaction. Never publishes: that is `publishRecordedEvents`, after commit. */
export async function recordDomainEvent<T extends TriggerName>(
  tx: Prisma.TransactionClient,
  input: {
    organizationId: string;
    actorUserId: string | null;
    type: T;
    data: EventDataMap[T];
  },
): Promise<RecordedEvent<T>> {
  const now = new Date();
  const event: RecordedEvent<T> = {
    id: randomUUID(),
    type: input.type,
    organizationId: input.organizationId,
    occurredAt: now.toISOString(),
    actorUserId: input.actorUserId,
    data: input.data,
    // Remembered so a retry cannot turn an automation's own change into a trigger (no loops).
    causedByAutomation: isCausedByAutomation(),
    recorded: true,
  };
  await domainEventOutboxRepository.insert(
    {
      id: event.id,
      organizationId: event.organizationId,
      type: event.type,
      actorUserId: event.actorUserId,
      data: storable(event.type, input.data as Record<string, unknown>) as Prisma.InputJsonValue,
      causedByAutomation: event.causedByAutomation,
      occurredAt: now,
      leaseUntil: new Date(now.getTime() + OUTBOX_INITIAL_LEASE_MS),
    },
    tx,
  );
  metrics.increment("domain_event_outbox_total", { result: "recorded", type: event.type });
  return event;
}

function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
}

async function deliver(event: DomainEvent, redeliver: boolean): Promise<void> {
  // The realtime hint is best effort and idempotent; automations are awaited so a failure is known.
  void publishForDomainEvent(event);
  await dispatchEventStrict(event, { redeliver });
}

async function succeed(id: string): Promise<void> {
  await domainEventOutboxRepository.markPublished(id, new Date());
}

async function fail(id: string, attempts: number, code: string): Promise<void> {
  await domainEventOutboxRepository.markFailed(
    id,
    code,
    new Date(Date.now() + backoffMs(attempts)),
  );
}

/**
 * Publishes events this request just recorded (after its transaction committed). It never throws: a failure
 * leaves the event unpublished with a retry time, and the reconciler delivers it later.
 */
export async function publishRecordedEvents(events: RecordedEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deliver(event, false);
      await succeed(event.id);
      metrics.increment("domain_event_outbox_total", { result: "published", type: event.type });
    } catch (error) {
      log.error(
        {
          organizationId: event.organizationId,
          eventId: event.id,
          eventType: event.type,
          err: error instanceof Error ? error.name : "unknown",
        },
        "event publication failed; the reconciler will retry",
      );
      metrics.increment("domain_event_outbox_total", { result: "failed", type: event.type });
      await fail(event.id, 0, "publish_failed").catch(() => undefined);
    }
  }
}

async function toEvent(row: OutboxRow): Promise<DomainEvent | null> {
  if (!getTrigger(row.type)) return null;
  const data = { ...((row.data as Record<string, unknown>) ?? {}) };
  if (row.type === "message.created" && typeof data.messageId === "string") {
    // The text is not stored in the outbox; automation conditions read it from here.
    data.body =
      (await domainEventOutboxRepository.messageBody(row.organizationId, data.messageId)) ?? "";
  }
  return {
    id: row.id,
    type: row.type as TriggerName,
    organizationId: row.organizationId,
    occurredAt: row.occurredAt.toISOString(),
    actorUserId: row.actorUserId,
    data: data as DomainEvent["data"],
    causedByAutomation: row.causedByAutomation,
  };
}

export type ReconcileResult = { claimed: number; published: number; failed: number };

/**
 * Re-publishes events nobody published (a crash between commit and publication, a queue outage). Safe to run
 * from any number of workers at once: each event is claimed with a conditional update, and publication is
 * idempotent by event id anyway.
 */
export async function reconcileOutbox(
  options: { limit?: number; now?: Date } = {},
): Promise<ReconcileResult> {
  const now = options.now ?? new Date();
  const claimed = await domainEventOutboxRepository.claimDue(
    options.limit ?? 50,
    now,
    new Date(now.getTime() + OUTBOX_RECONCILE_LEASE_MS),
  );
  const result: ReconcileResult = { claimed: claimed.length, published: 0, failed: 0 };
  for (const row of claimed) {
    try {
      const event = await toEvent(row);
      if (!event) throw new Error("unknown_event");
      await deliver(event, true);
      await succeed(row.id);
      result.published++;
      metrics.increment("domain_event_outbox_total", { result: "redelivered", type: row.type });
    } catch (error) {
      result.failed++;
      const code =
        error instanceof Error && error.message === "unknown_event"
          ? "unknown_event"
          : "publish_failed";
      log.error(
        {
          organizationId: row.organizationId,
          eventId: row.id,
          eventType: row.type,
          attempts: row.attempts + 1,
          code,
        },
        "event redelivery failed",
      );
      metrics.increment("domain_event_outbox_total", { result: "failed", type: row.type });
      await fail(row.id, row.attempts + 1, code).catch(() => undefined);
    }
  }
  return result;
}

/** Published events are only kept as a short audit trail. */
export const OUTBOX_PUBLISHED_RETENTION_DAYS = 7;

export async function purgePublishedOutbox(
  options: { olderThanDays?: number; now?: Date } = {},
): Promise<number> {
  const days = options.olderThanDays ?? OUTBOX_PUBLISHED_RETENTION_DAYS;
  if (!Number.isFinite(days) || days < 1)
    throw new Error("Outbox retention must be at least 1 day");
  const now = options.now ?? new Date();
  return domainEventOutboxRepository.deletePublishedBefore(
    new Date(now.getTime() - days * 24 * 3600_000),
  );
}
