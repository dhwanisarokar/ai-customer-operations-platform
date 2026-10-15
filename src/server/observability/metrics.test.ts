import { beforeEach, describe, expect, it } from "vitest";
import { metrics, safeLabel } from "./metrics";

beforeEach(() => metrics.reset());

describe("safeLabel: only codes and ids can become label values", () => {
  it.each(["held", "rate_limited_sender", "bad_signature", "held_limit_reason", "a1:b2", "x.y-z"])(
    "keeps the code %s",
    (value) => {
      expect(safeLabel(value)).toBe(value);
    },
  );

  it("keeps a UUID", () => {
    const id = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01";
    expect(safeLabel(id)).toBe(id);
  });

  it.each([
    "eve@customer.test",
    "Hello, my card is 4111 1111 1111 1111",
    "Re: Invoice",
    "secret-token abc",
    "UPPER",
    "",
    "x".repeat(65),
    "line\nbreak",
    "<script>",
  ])("replaces %j with 'other' so it can never reach a log line", (value) => {
    expect(safeLabel(value)).toBe("other");
  });

  it("coerces numbers and booleans to codes", () => {
    expect(safeLabel(3)).toBe("3");
    expect(safeLabel(true)).toBe("true");
  });
});

describe("metrics registry", () => {
  it("counts per label set and totals across them", () => {
    metrics.increment("email_inbound_total", { outcome: "held", reason: "archived_customer" });
    metrics.increment("email_inbound_total", { outcome: "held", reason: "archived_customer" });
    metrics.increment("email_inbound_total", { outcome: "processed" });
    expect(metrics.snapshot()["email_inbound_total{outcome=held,reason=archived_customer}"]).toBe(
      2,
    );
    expect(metrics.total("email_inbound_total")).toBe(3);
    expect(metrics.total("email_inbound_total", { outcome: "held" })).toBe(2);
    expect(metrics.total("email_inbound_total", { outcome: "ignored" })).toBe(0);
  });

  it("label order does not matter and undefined labels are dropped", () => {
    metrics.increment("email_inbound_total", {
      reason: "x",
      outcome: "held",
      organizationId: undefined,
    });
    expect(Object.keys(metrics.snapshot())).toEqual(["email_inbound_total{outcome=held,reason=x}"]);
  });

  it("refuses label KEYS that are not plain identifiers", () => {
    metrics.increment("email_inbound_total", { "bad key": "x", Evil: "y", ok: "z" } as never);
    expect(Object.keys(metrics.snapshot())).toEqual(["email_inbound_total{ok=z}"]);
  });

  it("a gauge holds the last value instead of adding up", () => {
    metrics.gauge("email_held_open", 5, { reason: "ambiguous_thread" });
    metrics.gauge("email_held_open", 2, { reason: "ambiguous_thread" });
    expect(metrics.snapshot()["email_held_open{reason=ambiguous_thread}"]).toBe(2);
  });

  it("never records an address or text even when a caller passes one as a label", () => {
    metrics.increment("email_inbound_total", { reason: "eve@customer.test" });
    expect(JSON.stringify(metrics.snapshot())).not.toMatch(/eve@/);
  });
});
