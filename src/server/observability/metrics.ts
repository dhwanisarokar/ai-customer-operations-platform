import { createLogger } from "@/lib/logger";

/**
 * Structured operational metrics without a metrics backend. Every increment or gauge is (1) kept in an
 * in-process registry (`snapshot()`, for tests and a future /metrics endpoint) and (2) written as ONE
 * structured log line with a fixed shape:
 *
 *   { module: "metrics", metric: "email_inbound_total", kind: "counter", value: 1, outcome: "held", ... }
 *
 * so any log pipeline (CloudWatch metric filters, Loki, Datadog logs-to-metrics) can count and alert on them
 * across instances. The in-process registry is per instance by nature; cross-instance totals come from the
 * log pipeline, or from the database-derived gauges the maintenance tick computes.
 *
 * Privacy: labels are restricted to short machine codes and ids (see `safeLabel`). Anything else (an address,
 * a subject, free text, a secret) is replaced by "other" so it can never reach a log line through a metric.
 */

const log = createLogger("metrics");

export type MetricLabels = Record<string, string | number | boolean | undefined>;

export type MetricName =
  // email webhook
  | "email_webhook_rejected_total"
  | "email_fetch_unavailable_total"
  | "email_inbound_total"
  | "email_quota_exhausted_total"
  | "email_held_queue_saturated_total"
  // durable events
  | "domain_event_outbox_total"
  | "email_held_expired_total"
  | "email_outbound_total"
  | "email_outbound_rejected_total"
  | "email_provider_rejected_total"
  | "email_outbound_due"
  | "email_outbound_oldest_due_age_seconds"
  | "email_outbound_unknown"
  | "email_outbound_processing"
  | "email_outbound_retry_waiting"
  | "email_outbound_expired_leases"
  | "maintenance_pass_total"
  // database-derived gauges (computed by the maintenance tick)
  | "email_held_open"
  | "email_dropped_last_hour"
  | "email_webhook_events_rows"
  | "domain_event_outbox_backlog"
  | "domain_event_outbox_oldest_age_seconds"
  | "domain_event_outbox_max_attempts";

const SAFE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Only short lower-case codes and UUIDs may be metric label values. */
export function safeLabel(value: string | number | boolean): string {
  const text = String(value);
  return SAFE.test(text) || UUID.test(text) ? text : "other";
}

function cleanLabels(labels: MetricLabels = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(labels).sort()) {
    const value = labels[key];
    if (value === undefined) continue;
    // Label KEYS are code constants; refuse anything that is not a plain identifier.
    if (!/^[a-z][a-zA-Z0-9_]{0,31}$/.test(key)) continue;
    out[key] = safeLabel(value);
  }
  return out;
}

const series = new Map<string, number>();

function keyOf(name: string, labels: Record<string, string>): string {
  const rendered = Object.entries(labels)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return rendered ? `${name}{${rendered}}` : name;
}

export const metrics = {
  increment(name: MetricName, labels?: MetricLabels, value = 1): void {
    const clean = cleanLabels(labels);
    const key = keyOf(name, clean);
    series.set(key, (series.get(key) ?? 0) + value);
    log.info({ metric: name, kind: "counter", value, ...clean }, "metric");
  },

  gauge(name: MetricName, value: number, labels?: MetricLabels): void {
    const clean = cleanLabels(labels);
    series.set(keyOf(name, clean), value);
    log.info({ metric: name, kind: "gauge", value, ...clean }, "metric");
  },

  /** Current values by series key, e.g. `email_inbound_total{outcome=held,reason=archived_customer}`. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(series);
  },

  /** Sum of every series of a metric whose labels include all of `where`. */
  total(name: MetricName, where: Record<string, string> = {}): number {
    let sum = 0;
    for (const [key, value] of series) {
      if (key !== name && !key.startsWith(`${name}{`)) continue;
      if (Object.entries(where).every(([k, v]) => key.includes(`${k}=${v}`))) sum += value;
    }
    return sum;
  },

  reset(): void {
    series.clear();
  },
};
