import { describe, expect, it } from "vitest";
import { ALERT_THRESHOLDS } from "../maintenance";
import {
  evaluateBackgroundHealth,
  isWorkerRequired,
  WORKER_STALE_AFTER_MS,
} from "./background-health";

const now = new Date("2026-10-14T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const evaluate = (over: Partial<Parameters<typeof evaluateBackgroundHealth>[0]> = {}) =>
  evaluateBackgroundHealth({
    workerRequired: true,
    heartbeat: { lastSuccessAt: ago(10_000) },
    oldestUnpublishedEventSeconds: 0,
    now,
    ...over,
  });

describe("isWorkerRequired", () => {
  it.each([
    [{ NODE_ENV: "production" }, true],
    [{ NODE_ENV: "development", REDIS_URL: "redis://x" }, true],
    [{ NODE_ENV: "development", REDIS_URL: "redis://x", AUTOMATION_QUEUE_DRIVER: "memory" }, false],
    [{ NODE_ENV: "development", AUTOMATION_QUEUE_DRIVER: "bullmq" }, true],
    [{ NODE_ENV: "development" }, false],
    [{ NODE_ENV: "test" }, false],
  ])("%j -> %s", (env, expected) => {
    expect(isWorkerRequired(env)).toBe(expected);
  });
});

describe("evaluateBackgroundHealth", () => {
  it("is ok when the worker reported recently and nothing is waiting", () => {
    expect(evaluate()).toMatchObject({
      status: "ok",
      checks: { worker: "ok", events: "ok" },
      details: { workerLastSuccessAgeSeconds: 10 },
    });
  });

  it("flags a worker that stopped (no successful pass for three intervals)", () => {
    const stale = evaluate({ heartbeat: { lastSuccessAt: ago(WORKER_STALE_AFTER_MS + 1000) } });
    expect(stale).toMatchObject({ status: "degraded", checks: { worker: "stale" } });
    expect(
      evaluate({ heartbeat: { lastSuccessAt: ago(WORKER_STALE_AFTER_MS - 1000) } }).status,
    ).toBe("ok");
  });

  it("flags a worker that never reported when one is required", () => {
    expect(evaluate({ heartbeat: null })).toMatchObject({
      status: "degraded",
      checks: { worker: "never" },
    });
    // A heartbeat row with only failures (no success yet) is the same.
    expect(evaluate({ heartbeat: { lastSuccessAt: null } }).checks.worker).toBe("never");
  });

  it("does not require a worker in plain local development", () => {
    expect(evaluate({ workerRequired: false, heartbeat: null })).toMatchObject({
      status: "ok",
      checks: { worker: "not_required" },
    });
  });

  it("detects a dead worker from the events themselves, with no heartbeat needed", () => {
    expect(
      evaluate({ oldestUnpublishedEventSeconds: ALERT_THRESHOLDS.outboxOldestAgeWarnSeconds }),
    ).toMatchObject({
      status: "degraded",
      checks: { events: "delayed" },
    });
    expect(
      evaluate({
        workerRequired: false,
        heartbeat: null,
        oldestUnpublishedEventSeconds: ALERT_THRESHOLDS.outboxOldestAgeCriticalSeconds,
      }),
    ).toMatchObject({ status: "degraded", checks: { events: "stuck" } });
  });

  it("reports numbers only: no tenant data", () => {
    expect(JSON.stringify(evaluate())).not.toMatch(/organization|@|[0-9a-f]{8}-[0-9a-f]{4}/);
  });
});
