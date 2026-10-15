import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import {
  ALERT_THRESHOLDS,
  MAINTENANCE_HEARTBEAT,
  MAINTENANCE_INTERVAL_MS,
} from "@/server/maintenance";
import { domainEventOutboxRepository } from "@/server/repositories/domain-event-outbox";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { workerHeartbeatRepository } from "@/server/repositories/worker-heartbeat";

const log = createLogger("health");

/**
 * Health of the BACKGROUND tier (the worker), separate from `/api/health` on purpose: `/api/health` is the
 * web tier's liveness/readiness (database reachable) and may be wired to an orchestrator that restarts or
 * removes instances when it fails. A stopped worker must page someone, not take the web tier out of rotation.
 *
 * It is computed entirely from PostgreSQL, so it works when the worker is dead (a dead worker cannot report
 * itself): the worker's heartbeat row, and the age of the oldest domain event nobody has published.
 */

/** No successful pass for this long = the worker is considered stopped (three missed intervals). */
export const WORKER_STALE_AFTER_MS = 3 * MAINTENANCE_INTERVAL_MS;

export type WorkerState = "ok" | "stale" | "never" | "not_required";
export type EventsState = "ok" | "delayed" | "stuck";
/** Outbound email that is due (a retry time reached, or a worker died holding it) but not sent. */
export type OutboundState = "ok" | "delayed" | "stuck";

export type BackgroundHealth = {
  status: "ok" | "degraded";
  checks: { worker: WorkerState; events: EventsState; outbound: OutboundState };
  /** Numbers only; nothing tenant-specific. */
  details: {
    workerLastSuccessAgeSeconds: number | null;
    oldestUnpublishedEventSeconds: number;
    oldestDueEmailSeconds: number;
    /** Sends whose outcome is unknown: informational (an operator decides), not a health failure. */
    unknownEmails: number;
    /** Outbound emails due now (waiting past their time or whose lease expired). Scheduled retries are NOT counted. */
    dueEmails: number;
    /** In-flight sends whose lease expired: a worker died or hung holding them. */
    expiredEmailLeases: number;
  };
};

/**
 * Is a worker expected? In production, or whenever the BullMQ queue driver is in use (Redis configured), the
 * worker is the only thing that runs queued jobs, retries unpublished events and applies retention. In plain
 * local development (in-process queue) there is none, and that is fine.
 */
export function isWorkerRequired(env: {
  NODE_ENV: string;
  REDIS_URL?: string;
  AUTOMATION_QUEUE_DRIVER?: string;
}): boolean {
  const bull = env.AUTOMATION_QUEUE_DRIVER
    ? env.AUTOMATION_QUEUE_DRIVER === "bullmq"
    : Boolean(env.REDIS_URL);
  return env.NODE_ENV === "production" || bull;
}

/** Pure decision from the facts; see the tests for the table. */
export function evaluateBackgroundHealth(input: {
  workerRequired: boolean;
  heartbeat: { lastSuccessAt: Date | null } | null;
  oldestUnpublishedEventSeconds: number;
  oldestDueEmailSeconds?: number;
  unknownEmails?: number;
  dueEmails?: number;
  expiredEmailLeases?: number;
  now: Date;
}): BackgroundHealth {
  const lastSuccess = input.heartbeat?.lastSuccessAt ?? null;
  const age = lastSuccess
    ? Math.max(0, Math.floor((input.now.getTime() - lastSuccess.getTime()) / 1000))
    : null;

  let worker: WorkerState;
  if (!input.workerRequired) worker = "not_required";
  else if (age === null) worker = "never";
  else worker = age * 1000 > WORKER_STALE_AFTER_MS ? "stale" : "ok";

  const oldest = input.oldestUnpublishedEventSeconds;
  const events: EventsState =
    oldest >= ALERT_THRESHOLDS.outboxOldestAgeCriticalSeconds
      ? "stuck"
      : oldest >= ALERT_THRESHOLDS.outboxOldestAgeWarnSeconds
        ? "delayed"
        : "ok";

  const dueEmail = input.oldestDueEmailSeconds ?? 0;
  const outbound: OutboundState =
    dueEmail >= ALERT_THRESHOLDS.outboundDueCriticalSeconds
      ? "stuck"
      : dueEmail >= ALERT_THRESHOLDS.outboundDueWarnSeconds
        ? "delayed"
        : "ok";

  const degraded = worker === "stale" || worker === "never" || events !== "ok" || outbound !== "ok";
  return {
    status: degraded ? "degraded" : "ok",
    checks: { worker, events, outbound },
    details: {
      workerLastSuccessAgeSeconds: age,
      oldestUnpublishedEventSeconds: oldest,
      oldestDueEmailSeconds: dueEmail,
      unknownEmails: input.unknownEmails ?? 0,
      dueEmails: input.dueEmails ?? 0,
      expiredEmailLeases: input.expiredEmailLeases ?? 0,
    },
  };
}

export async function checkBackgroundHealth(now: Date = new Date()): Promise<BackgroundHealth> {
  try {
    const [heartbeat, stats, email] = await Promise.all([
      workerHeartbeatRepository.find(MAINTENANCE_HEARTBEAT),
      domainEventOutboxRepository.stats(now),
      outboundEmailRepository.stats(now),
    ]);
    return evaluateBackgroundHealth({
      workerRequired: isWorkerRequired(getServerEnv()),
      heartbeat,
      oldestUnpublishedEventSeconds: stats.oldestAgeSeconds,
      oldestDueEmailSeconds: email.oldestDueAgeSeconds,
      unknownEmails: email.unknown,
      dueEmails: email.due,
      expiredEmailLeases: email.expiredLeases,
      now,
    });
  } catch (error) {
    // Cannot tell: report degraded rather than a false "ok".
    log.error(
      { err: error instanceof Error ? error.name : "unknown" },
      "background health check failed",
    );
    return {
      status: "degraded",
      checks: { worker: "never", events: "stuck", outbound: "stuck" },
      details: {
        workerLastSuccessAgeSeconds: null,
        oldestUnpublishedEventSeconds: -1,
        oldestDueEmailSeconds: -1,
        unknownEmails: -1,
        dueEmails: -1,
        expiredEmailLeases: -1,
      },
    };
  }
}
