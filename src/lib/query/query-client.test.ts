// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client";
import { getQueryClient, makeQueryClient, shouldRetry, STALE_TIME } from "./query-client";

describe("shouldRetry", () => {
  it("never retries requests the server rejected (4xx)", () => {
    for (const status of [400, 401, 403, 404, 409]) {
      expect(shouldRetry(0, new ApiError(status, "no"))).toBe(false);
    }
  });

  it("retries transient failures (network, 5xx) once", () => {
    expect(shouldRetry(0, new ApiError(0, "network"))).toBe(true);
    expect(shouldRetry(0, new ApiError(502, "bad gateway"))).toBe(true);
    expect(shouldRetry(1, new ApiError(502, "bad gateway"))).toBe(false);
    expect(shouldRetry(0, new Error("boom"))).toBe(true);
  });
});

describe("makeQueryClient defaults", () => {
  it("never retries mutations (writes must be explicit user actions)", () => {
    expect(makeQueryClient().getDefaultOptions().mutations?.retry).toBe(false);
  });

  it("refetches on focus/reconnect and keeps unused data for a few minutes", () => {
    const options = makeQueryClient().getDefaultOptions().queries!;
    expect(options.refetchOnWindowFocus).toBe(true);
    expect(options.refetchOnReconnect).toBe(true);
    expect(options.gcTime).toBe(5 * 60_000);
  });

  it("creates independent clients", () => {
    expect(makeQueryClient()).not.toBe(makeQueryClient());
  });
});

describe("stale times", () => {
  it("are shorter where freshness matters (inbox) and longer for rarely-changing data", () => {
    expect(STALE_TIME.messages).toBeLessThan(STALE_TIME.conversations);
    expect(STALE_TIME.conversations).toBeLessThan(STALE_TIME.customers);
    expect(STALE_TIME.customers).toBeLessThan(STALE_TIME.knowledge);
  });
});

describe("getQueryClient", () => {
  it("returns one shared client per browser tab (not one per render)", () => {
    expect(getQueryClient()).toBe(getQueryClient());
  });
});
