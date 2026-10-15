import { describe, expect, it } from "vitest";
import {
  assertReplayPolicy,
  requiredLedgerRetentionDays,
  type ReplayPolicy,
} from "./replay-policy";

const policy = (over: Partial<ReplayPolicy> = {}): ReplayPolicy => ({
  freshnessSeconds: 300,
  retryHorizonSeconds: 8 * 3600,
  retriesResigned: true,
  ...over,
});

describe("assertReplayPolicy", () => {
  it("accepts re-signed retries with a short window", () => {
    expect(() => assertReplayPolicy(policy())).not.toThrow();
  });

  it("accepts original-timestamp retries when the window covers the retry horizon", () => {
    expect(() =>
      assertReplayPolicy(policy({ retriesResigned: false, freshnessSeconds: 8 * 3600 })),
    ).not.toThrow();
  });

  it("REFUSES original-timestamp retries with a window shorter than the horizon (retries would be refused as stale)", () => {
    expect(() => assertReplayPolicy(policy({ retriesResigned: false }))).toThrow(/stale/);
  });

  it.each([0, -1, 1.5, Number.NaN])("refuses a freshness window of %s", (freshnessSeconds) => {
    expect(() => assertReplayPolicy(policy({ freshnessSeconds }))).toThrow();
  });

  it.each([-1, 1.5, Number.NaN])("refuses a retry horizon of %s", (retryHorizonSeconds) => {
    expect(() => assertReplayPolicy(policy({ retryHorizonSeconds }))).toThrow();
  });
});

describe("requiredLedgerRetentionDays", () => {
  it("is at least one day", () => {
    expect(requiredLedgerRetentionDays(policy({ retryHorizonSeconds: 0 }))).toBe(1);
  });

  it("is twice the longest replay span, rounded up to whole days", () => {
    // 8 h horizon + 5 min window = 8.083 h; twice = 16.17 h -> 1 day
    expect(requiredLedgerRetentionDays(policy())).toBe(1);
    // a 10-day horizon needs 20+ days
    expect(requiredLedgerRetentionDays(policy({ retryHorizonSeconds: 10 * 86_400 }))).toBe(21);
  });
});
