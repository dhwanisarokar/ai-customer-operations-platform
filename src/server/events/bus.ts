import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logger";
import type { TriggerName } from "@/server/automation/catalog";
import { publishForDomainEvent } from "@/server/realtime/domain";
import type { DomainEvent, EventDataMap } from "./types";

const log = createLogger("events");

/**
 * Marks work done by an automation's action. Events emitted inside it are flagged, and the engine
 * ignores flagged events: automations cannot trigger automations, so there are no loops.
 */
const automationOrigin = new AsyncLocalStorage<{ automationId: string }>();
/** Is the current call chain running inside an automation's action? Recorded with every durable event. */
export function isCausedByAutomation(): boolean {
  return automationOrigin.getStore() !== undefined;
}

export function runAsAutomation<T>(automationId: string, fn: () => Promise<T>): Promise<T> {
  return automationOrigin.run({ automationId }, fn);
}

/**
 * Emits a domain event. Call it AFTER the transaction that caused it has committed (so failed
 * transactions never emit). Dispatching is best effort: a problem in the automation engine or queue
 * is logged and never breaks the request that caused the event.
 */
export async function emitDomainEvent<T extends TriggerName>(input: {
  organizationId: string;
  actorUserId: string | null;
  type: T;
  data: EventDataMap[T];
}): Promise<DomainEvent<T>> {
  const event: DomainEvent<T> = {
    id: randomUUID(),
    type: input.type,
    organizationId: input.organizationId,
    occurredAt: new Date().toISOString(),
    actorUserId: input.actorUserId,
    data: input.data,
    causedByAutomation: automationOrigin.getStore() !== undefined,
  };
  // Realtime hints are best effort and must not delay the request: the database is already
  // committed, and clients reconcile by refetching. (Automations below are awaited on purpose.)
  void publishForDomainEvent(event);
  await dispatchEvent(event);
  return event;
}

/**
 * Hands an event to the automation engine and THROWS if that failed, so a caller that can retry (the outbox)
 * knows whether it worked. `redeliver` is for a re-publication of an already-recorded event.
 */
export async function dispatchEventStrict(
  event: DomainEvent,
  options: { redeliver?: boolean } = {},
): Promise<void> {
  // Lazy import: the engine depends on services that emit events.
  const { dispatchDomainEvent } = await import("@/server/automation/engine");
  await dispatchDomainEvent(event, options.redeliver ? { redeliver: true } : {});
}

/** Hands an event to the automation engine. Also used to replay an event (same id = no duplicates). */
export async function dispatchEvent(event: DomainEvent): Promise<void> {
  try {
    await dispatchEventStrict(event);
  } catch (error) {
    log.error(
      {
        organizationId: event.organizationId,
        eventId: event.id,
        eventType: event.type,
        err: error instanceof Error ? error.name : "unknown",
      },
      "event dispatch failed",
    );
  }
}
