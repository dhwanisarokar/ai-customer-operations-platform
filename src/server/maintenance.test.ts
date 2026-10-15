import { describe, expect, it } from "vitest";
import { INBOUND_LIMITS } from "./email/inbound";
import { ALERT_THRESHOLDS, evaluateAlerts, type Gauges } from "./maintenance";

const quiet: Gauges = {
  outbox: { backlog: 0, oldestAgeSeconds: 0, maxAttempts: 0 },
  heldOpen: [],
  droppedLastHour: [],
  webhookEventRows: 0,
  outboundEmail: {
    due: 0,
    oldestDueAgeSeconds: 0,
    unknown: 0,
    processing: 0,
    retryWaiting: 0,
    expiredLeases: 0,
  },
};
const org = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01";
const names = (g: Gauges) => evaluateAlerts(g).map((a) => `${a.severity}:${a.name}`);

describe("evaluateAlerts", () => {
  it("is silent when everything is healthy", () => {
    expect(evaluateAlerts(quiet)).toEqual([]);
  });

  it("flags delayed and then stuck domain events by age", () => {
    const at = (s: number) => ({
      ...quiet,
      outbox: { ...quiet.outbox, backlog: 1, oldestAgeSeconds: s },
    });
    expect(names(at(ALERT_THRESHOLDS.outboxOldestAgeWarnSeconds - 1))).toEqual([]);
    expect(names(at(ALERT_THRESHOLDS.outboxOldestAgeWarnSeconds))).toEqual([
      "warn:domain_event_outbox_delayed",
    ]);
    expect(names(at(ALERT_THRESHOLDS.outboxOldestAgeCriticalSeconds))).toEqual([
      "critical:domain_event_outbox_stuck",
    ]);
  });

  it("flags a large backlog and repeated failures", () => {
    expect(
      names({
        ...quiet,
        outbox: {
          backlog: ALERT_THRESHOLDS.outboxBacklogWarn,
          oldestAgeSeconds: 0,
          maxAttempts: 0,
        },
      }),
    ).toEqual(["warn:domain_event_outbox_backlog"]);
    expect(
      names({
        ...quiet,
        outbox: {
          backlog: 1,
          oldestAgeSeconds: 0,
          maxAttempts: ALERT_THRESHOLDS.outboxAttemptsWarn,
        },
      }),
    ).toEqual(["warn:domain_event_outbox_retrying"]);
  });

  it("warns when a held queue fills (80% of its cap) and is critical at the cap, per reason", () => {
    const cap = INBOUND_LIMITS.openHeldByReason.UNAUTHENTICATED_SENDER;
    const held = (count: number) => ({
      ...quiet,
      heldOpen: [{ organizationId: org, reason: "unauthenticated_sender", count }],
    });
    expect(names(held(Math.ceil(cap * ALERT_THRESHOLDS.heldWarnRatio) - 1))).toEqual([]);
    expect(names(held(Math.ceil(cap * ALERT_THRESHOLDS.heldWarnRatio)))).toEqual([
      "warn:email_held_queue_filling",
    ]);
    expect(names(held(cap))).toEqual(["critical:email_held_queue_full"]);
  });

  it("warns on an exhausted quota and is critical on heavy or held-limit drops", () => {
    const dropped = (reason: string, count: number) => ({
      ...quiet,
      droppedLastHour: [{ reason, count }],
    });
    expect(names(dropped("rate_limited_sender", 1))).toEqual(["warn:email_quota_exhausted"]);
    expect(
      names(dropped("rate_limited_organization", ALERT_THRESHOLDS.droppedLastHourCritical)),
    ).toEqual(["critical:email_dropped_by_limit"]);
    expect(names(dropped("held_limit", 1))).toEqual(["critical:email_dropped_by_limit"]);
    expect(names(dropped("held_limit_reason", 1))).toEqual(["critical:email_dropped_by_limit"]);
  });

  it("ignores ordinary ignore reasons (loops, automated mail, unknown recipients)", () => {
    expect(
      names({
        ...quiet,
        droppedLastHour: [
          { reason: "loop", count: 500 },
          { reason: "automated", count: 500 },
          { reason: "unknown_recipient", count: 500 },
        ],
      }),
    ).toEqual([]);
  });

  it("outbound email: a backlog (50 due at once) warns even when none is old; waiting retries never alert", () => {
    const mk = (outboundEmail: Partial<Gauges["outboundEmail"]>) => ({
      ...quiet,
      outboundEmail: { ...quiet.outboundEmail, ...outboundEmail },
    });
    expect(names(mk({ due: ALERT_THRESHOLDS.outboundDueBacklogWarn - 1 }))).toEqual([]);
    expect(names(mk({ due: ALERT_THRESHOLDS.outboundDueBacklogWarn }))).toEqual([
      "warn:email_outbound_backlog",
    ]);
    // Work waiting by design (scheduled retries, valid leases) is invisible to the alerts, however much of it there is.
    expect(names(mk({ retryWaiting: 5000, processing: 500 }))).toEqual([]);
  });

  it("outbound email: age alerts use the documented 10 / 60 minute thresholds, and UNKNOWN is a warning", () => {
    const mk = (outboundEmail: Partial<Gauges["outboundEmail"]>) => ({
      ...quiet,
      outboundEmail: { ...quiet.outboundEmail, ...outboundEmail },
    });
    expect(ALERT_THRESHOLDS.outboundDueWarnSeconds).toBe(600);
    expect(ALERT_THRESHOLDS.outboundDueCriticalSeconds).toBe(3600);
    expect(names(mk({ due: 1, oldestDueAgeSeconds: 599 }))).toEqual([]);
    expect(names(mk({ due: 1, oldestDueAgeSeconds: 600 }))).toEqual([
      "warn:email_outbound_delayed",
    ]);
    expect(names(mk({ due: 1, oldestDueAgeSeconds: 3600 }))).toEqual([
      "critical:email_outbound_stuck",
    ]);
    expect(names(mk({ unknown: 2 }))).toEqual(["warn:email_outbound_unknown"]);
  });

  it("alerts carry only codes and numbers", () => {
    const alerts = evaluateAlerts({
      ...quiet,
      heldOpen: [{ organizationId: org, reason: "archived_customer", count: 999 }],
    });
    expect(JSON.stringify(alerts)).not.toMatch(/@|subject|body/i);
  });

  it("the per-reason held caps stay within the overall queue cap", () => {
    const sum = Object.values(INBOUND_LIMITS.openHeldByReason).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThanOrEqual(INBOUND_LIMITS.openHeldPerOrganization);
  });
});
