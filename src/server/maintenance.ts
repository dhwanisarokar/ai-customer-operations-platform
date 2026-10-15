import { createLogger } from "@/lib/logger";
import { reconcileOutbox, purgePublishedOutbox } from "@/server/events/outbox";
import { INBOUND_LIMITS } from "@/server/email/inbound";
import { purgeExpiredWebhookEvents } from "@/server/email/inbound-webhook";
import { reconcileOutboundEmail } from "@/server/email/outbound";
import { expireHeldMessages } from "@/server/email/retention";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { workerHeartbeatRepository } from "@/server/repositories/worker-heartbeat";
import { metrics } from "@/server/observability/metrics";
import { domainEventOutboxRepository } from "@/server/repositories/domain-event-outbox";
import { emailInboundRepository } from "@/server/repositories/email-inbound";

const log = createLogger("maintenance");

/**
 * Periodic housekeeping that every deployment needs and that must survive restarts: re-publishing durable
 * events nobody published, expiring the replay ledger and published outbox rows, and computing the
 * database-derived operational gauges (with alert evaluation).
 *
 * Where it runs: inside the existing worker process (`npm run worker`, see scripts/automation-worker.ts) on a
 * timer. That adds no new infrastructure and no new dependency. It is safe with any number of workers: the
 * outbox claims rows with conditional updates, deletes are idempotent, gauges are read-only. A deployment
 * without the worker (the in-process development queue) simply does not run it; nothing is lost, the work
 * waits in the database until a worker runs.
 */

export const MAINTENANCE_INTERVAL_MS = 60_000;
/** The heartbeat name of this loop (see `worker_heartbeats`, `background-health.ts`). */
export const MAINTENANCE_HEARTBEAT = "maintenance";
/** Retention deletes are cheap but need not run every minute. */
export const PURGE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Alert thresholds (proposals, tuned by evidence). `critical` means mail or events are being lost or about
 * to be; `warn` means capacity is being used up. Counters are per instance; these evaluate the
 * database-derived gauges, which are the same from every worker.
 */
export const ALERT_THRESHOLDS = {
  outboxOldestAgeWarnSeconds: 5 * 60,
  outboxOldestAgeCriticalSeconds: 30 * 60,
  outboxBacklogWarn: 100,
  outboxAttemptsWarn: 8,
  heldWarnRatio: 0.8,
  droppedLastHourWarn: 1,
  droppedLastHourCritical: 25,
  // Outbound email that is DUE (retry time reached, or a worker died holding it) but not yet sent: the worker is
  // behind or stopped. Retries are scheduled with backoff, so only DUE work counts, never work waiting by design.
  outboundDueWarnSeconds: 10 * 60,
  outboundDueCriticalSeconds: 60 * 60,
  // NEW in 9.4 (explicit): many sends due at once means the worker cannot keep up even if none is old yet. Ordinary
  // retries waiting for their scheduled time are never counted.
  outboundDueBacklogWarn: 50,
} as const;

export type Gauges = {
  outbox: { backlog: number; oldestAgeSeconds: number; maxAttempts: number };
  heldOpen: { organizationId: string; reason: string; count: number }[];
  droppedLastHour: { reason: string; count: number }[];
  webhookEventRows: number;
  outboundEmail: {
    due: number;
    oldestDueAgeSeconds: number;
    unknown: number;
    processing: number;
    retryWaiting: number;
    expiredLeases: number;
  };
};

export type Alert = {
  name: string;
  severity: "warn" | "critical";
  message: string;
  value: number;
  threshold: number;
};

export async function collectGauges(now: Date = new Date()): Promise<Gauges> {
  const [outbox, held, dropped, rows, outboundEmail] = await Promise.all([
    domainEventOutboxRepository.stats(now),
    emailInboundRepository.openHeldByOrganization(),
    emailInboundRepository.ignoredReasonsSince(new Date(now.getTime() - 3600_000)),
    emailInboundRepository.countWebhookEvents(),
    outboundEmailRepository.stats(now),
  ]);
  return {
    outbox,
    outboundEmail,
    heldOpen: held.map((row) => ({
      organizationId: row.organizationId,
      reason: row.reason.toLowerCase(),
      count: row._count._all,
    })),
    droppedLastHour: dropped.map((row) => ({
      reason: row.reason ?? "unknown",
      count: row._count._all,
    })),
    webhookEventRows: rows,
  };
}

export function publishGauges(gauges: Gauges): void {
  metrics.gauge("domain_event_outbox_backlog", gauges.outbox.backlog);
  metrics.gauge("domain_event_outbox_oldest_age_seconds", gauges.outbox.oldestAgeSeconds);
  metrics.gauge("domain_event_outbox_max_attempts", gauges.outbox.maxAttempts);
  metrics.gauge("email_webhook_events_rows", gauges.webhookEventRows);
  metrics.gauge("email_outbound_due", gauges.outboundEmail.due);
  metrics.gauge("email_outbound_oldest_due_age_seconds", gauges.outboundEmail.oldestDueAgeSeconds);
  metrics.gauge("email_outbound_unknown", gauges.outboundEmail.unknown);
  metrics.gauge("email_outbound_processing", gauges.outboundEmail.processing);
  metrics.gauge("email_outbound_retry_waiting", gauges.outboundEmail.retryWaiting);
  metrics.gauge("email_outbound_expired_leases", gauges.outboundEmail.expiredLeases);
  for (const row of gauges.heldOpen) {
    metrics.gauge("email_held_open", row.count, {
      organizationId: row.organizationId,
      reason: row.reason,
    });
  }
  for (const row of gauges.droppedLastHour) {
    metrics.gauge("email_dropped_last_hour", row.count, { reason: row.reason });
  }
}

/** Pure: which gauges are past their thresholds. No I/O, no content, only codes and numbers. */
export function evaluateAlerts(gauges: Gauges): Alert[] {
  const t = ALERT_THRESHOLDS;
  const alerts: Alert[] = [];

  const age = gauges.outbox.oldestAgeSeconds;
  if (age >= t.outboxOldestAgeCriticalSeconds) {
    alerts.push({
      name: "domain_event_outbox_stuck",
      severity: "critical",
      message:
        "Domain events have been unpublished for a long time (realtime and automations are not firing)",
      value: age,
      threshold: t.outboxOldestAgeCriticalSeconds,
    });
  } else if (age >= t.outboxOldestAgeWarnSeconds) {
    alerts.push({
      name: "domain_event_outbox_delayed",
      severity: "warn",
      message: "Domain events are waiting longer than expected to be published",
      value: age,
      threshold: t.outboxOldestAgeWarnSeconds,
    });
  }
  if (gauges.outbox.backlog >= t.outboxBacklogWarn) {
    alerts.push({
      name: "domain_event_outbox_backlog",
      severity: "warn",
      message: "Many domain events are waiting to be published",
      value: gauges.outbox.backlog,
      threshold: t.outboxBacklogWarn,
    });
  }
  if (gauges.outbox.maxAttempts >= t.outboxAttemptsWarn) {
    alerts.push({
      name: "domain_event_outbox_retrying",
      severity: "warn",
      message: "A domain event has failed to publish repeatedly",
      value: gauges.outbox.maxAttempts,
      threshold: t.outboxAttemptsWarn,
    });
  }

  const due = gauges.outboundEmail.oldestDueAgeSeconds;
  if (due >= t.outboundDueCriticalSeconds) {
    alerts.push({
      name: "email_outbound_stuck",
      severity: "critical",
      message:
        "Outbound email is due but not being sent (the worker is stopped or the provider is unavailable)",
      value: due,
      threshold: t.outboundDueCriticalSeconds,
    });
  } else if (due >= t.outboundDueWarnSeconds) {
    alerts.push({
      name: "email_outbound_delayed",
      severity: "warn",
      message: "Outbound email is waiting longer than expected to be sent",
      value: due,
      threshold: t.outboundDueWarnSeconds,
    });
  }
  if (gauges.outboundEmail.due >= t.outboundDueBacklogWarn) {
    alerts.push({
      name: "email_outbound_backlog",
      severity: "warn",
      message: "Many outbound emails are due at once: the worker is not keeping up",
      value: gauges.outboundEmail.due,
      threshold: t.outboundDueBacklogWarn,
    });
  }
  if (gauges.outboundEmail.unknown > 0) {
    // Not a failure of the system: a send whose outcome cannot be known. Someone must decide (see the docs).
    alerts.push({
      name: "email_outbound_unknown",
      severity: "warn",
      message:
        "Outbound email with an unknown outcome needs an operator (it may or may not have been delivered)",
      value: gauges.outboundEmail.unknown,
      threshold: 1,
    });
  }

  for (const row of gauges.heldOpen) {
    const cap =
      INBOUND_LIMITS.openHeldByReason[
        row.reason.toUpperCase() as keyof typeof INBOUND_LIMITS.openHeldByReason
      ];
    if (!cap) continue;
    if (row.count >= cap) {
      alerts.push({
        name: "email_held_queue_full",
        severity: "critical",
        message: `Held email of one kind is at its cap (${row.reason}); new mail of that kind is being dropped`,
        value: row.count,
        threshold: cap,
      });
    } else if (row.count >= Math.ceil(cap * t.heldWarnRatio)) {
      alerts.push({
        name: "email_held_queue_filling",
        severity: "warn",
        message: `Held email of one kind is filling up (${row.reason})`,
        value: row.count,
        threshold: Math.ceil(cap * t.heldWarnRatio),
      });
    }
  }

  for (const row of gauges.droppedLastHour) {
    if (!row.reason.startsWith("rate_limited") && !row.reason.startsWith("held_limit")) continue;
    if (row.count >= t.droppedLastHourCritical || row.reason.startsWith("held_limit")) {
      alerts.push({
        name: "email_dropped_by_limit",
        severity: "critical",
        message: `Inbound email is being dropped by a limit (${row.reason})`,
        value: row.count,
        threshold: row.reason.startsWith("held_limit") ? 1 : t.droppedLastHourCritical,
      });
    } else if (row.count >= t.droppedLastHourWarn) {
      alerts.push({
        name: "email_quota_exhausted",
        severity: "warn",
        message: `An inbound email quota was exhausted in the last hour (${row.reason})`,
        value: row.count,
        threshold: t.droppedLastHourWarn,
      });
    }
  }
  return alerts;
}

export type MaintenanceResult = {
  outbox: { claimed: number; published: number; failed: number };
  outboundEmail: { recovered: number; wokenUp: number };
  purged: { webhookEvents: number; outboxEvents: number; heldEmails: number } | null;
  alerts: Alert[];
};

/** One maintenance pass. `purge` is false on most ticks (retention is hourly, the reconciler is every minute). */
export async function runMaintenance(
  options: { now?: Date; purge?: boolean } = {},
): Promise<MaintenanceResult> {
  const now = options.now ?? new Date();
  const outbox = await reconcileOutbox({ now });
  // Outbound email: resolve attempts whose worker died and re-create lost wake-ups (see email/outbound.ts).
  const outboundEmail = await reconcileOutboundEmail({ now: () => now });
  const purged = options.purge
    ? {
        webhookEvents: await purgeExpiredWebhookEvents({ now }),
        outboxEvents: await purgePublishedOutbox({ now }),
        heldEmails: await expireHeldMessages({ now }),
      }
    : null;
  const gauges = await collectGauges(now);
  publishGauges(gauges);
  const alerts = evaluateAlerts(gauges);
  for (const alert of alerts) {
    // Codes and numbers only; never an address, a subject or a body.
    const line = { alert: alert.name, value: alert.value, threshold: alert.threshold };
    if (alert.severity === "critical") log.error(line, alert.message);
    else log.warn(line, alert.message);
  }
  // Last, so the heartbeat means "a whole pass completed".
  await workerHeartbeatRepository.recordSuccess(MAINTENANCE_HEARTBEAT, now);
  return { outbox, outboundEmail, purged, alerts };
}

/**
 * Starts the periodic loop (the worker calls this). Errors are logged and recorded in the heartbeat, never
 * thrown. Returns a stop function that resolves once an in-flight pass has finished (at most `graceMs`), so a
 * shutdown does not cut a pass in half; work a killed pass left behind is picked up by the next worker because
 * every claim is a short lease.
 */
export function startMaintenanceLoop(
  options: { intervalMs?: number; purgeIntervalMs?: number; graceMs?: number } = {},
): () => Promise<void> {
  const interval = options.intervalMs ?? MAINTENANCE_INTERVAL_MS;
  const purgeEvery = options.purgeIntervalMs ?? PURGE_INTERVAL_MS;
  const grace = options.graceMs ?? 10_000;
  let lastPurge = 0;
  let current: Promise<void> | null = null;
  let stopped = false;
  const tick = async () => {
    if (current || stopped) return; // a slow pass never overlaps the next one
    current = (async () => {
      try {
        const now = new Date();
        const purge = now.getTime() - lastPurge >= purgeEvery;
        await runMaintenance({ now, purge });
        if (purge) lastPurge = now.getTime();
        metrics.increment("maintenance_pass_total", { result: "ok" });
      } catch (error) {
        log.error(
          { err: error instanceof Error ? error.name : "unknown" },
          "maintenance pass failed",
        );
        metrics.increment("maintenance_pass_total", { result: "failed" });
        await workerHeartbeatRepository
          .recordFailure(MAINTENANCE_HEARTBEAT, "maintenance_failed", new Date())
          .catch(() => undefined);
      } finally {
        current = null;
      }
    })();
    await current;
  };
  const timer = setInterval(() => void tick(), interval);
  timer.unref?.();
  void tick();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (current) {
      await Promise.race([current, new Promise((resolve) => setTimeout(resolve, grace))]);
    }
  };
}
