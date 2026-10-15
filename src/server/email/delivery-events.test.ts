import { describe, expect, it } from "vitest";
import {
  NO_OUTCOME,
  RECEIPT_TYPES,
  correlateReceipt,
  deliveryReceiptSchema,
  describeOutcome,
  foldReceipts,
  isConfirmedDelivery,
  reduceOutcome,
  type DeliveryOutcome,
  type ReceiptType,
} from "./delivery-events";

const SEND_A = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01";
const SEND_B = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c02";
const ORG_A = "9a1b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c0a";
const ORG_B = "9a1b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c0b";

const receipt = (type: ReceiptType) => ({ type });
const perms = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, i) =>
        perms([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
      );

describe("deliveryReceiptSchema", () => {
  const valid = {
    eventId: "mailprovider:acct1:evt-123",
    providerMessageId: "pm-1",
    sendId: SEND_A,
    type: "delivered",
    occurredAt: new Date(),
    code: "delivered",
  };

  it("accepts a normalized receipt and defaults the optional fields", () => {
    expect(deliveryReceiptSchema.parse(valid).type).toBe("delivered");
    const minimal = deliveryReceiptSchema.parse({
      eventId: "p:a:1",
      providerMessageId: "pm",
      type: "accepted",
      occurredAt: new Date(),
    });
    expect(minimal).toMatchObject({ sendId: null, code: null });
  });

  it.each([
    ["an organization id (a payload never chooses a tenant)", { organizationId: ORG_A }],
    ["any unknown field", { raw: "provider response text" }],
    ["a provider response body", { response: { status: 250, text: "OK queued as abc" } }],
    ["a recipient address", { recipient: "eve@customer.test" }],
    ["an unknown type", { type: "opened" }],
    ["a transient-deferral type (adapters drop these)", { type: "deferred" }],
    ["a code that is provider text", { code: "550 5.1.1 user unknown" }],
    ["an event id with whitespace", { eventId: "p a 1" }],
    ["an empty event id", { eventId: "" }],
    ["a send id that is not a uuid", { sendId: "abc" }],
    ["a missing provider message id", { providerMessageId: undefined }],
    ["a string timestamp", { occurredAt: "2026-01-01" }],
  ])("rejects %s", (_label, patch) => {
    expect(deliveryReceiptSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});

describe("the outcome model: duplicates, order and regressions", () => {
  it("starts with no outcome and says nothing about delivery", () => {
    expect(NO_OUTCOME).toEqual({ level: "none", negative: null, complained: false });
    expect(isConfirmedDelivery(NO_OUTCOME)).toBe(false);
    expect(describeOutcome(NO_OUTCOME)).toBeNull();
  });

  it("provider ACCEPTANCE is never delivery", () => {
    const outcome = foldReceipts([receipt("accepted")]);
    expect(isConfirmedDelivery(outcome)).toBe(false);
    expect(describeOutcome(outcome)).toMatch(/accepted by the mail provider/i);
    expect(describeOutcome(outcome)).toMatch(/not confirmed/i);
    expect(describeOutcome(outcome)).not.toMatch(/\bdelivered\b/i);
  });

  it("only a delivered receipt (or a complaint, which proves it) is delivery evidence", () => {
    expect(isConfirmedDelivery(foldReceipts([receipt("delivered")]))).toBe(true);
    expect(isConfirmedDelivery(foldReceipts([receipt("complained")]))).toBe(true);
    expect(isConfirmedDelivery(foldReceipts([receipt("accepted"), receipt("accepted")]))).toBe(
      false,
    );
    expect(isConfirmedDelivery(foldReceipts([receipt("bounced")]))).toBe(false);
  });

  it("a duplicate of any receipt changes nothing (idempotent)", () => {
    for (const type of RECEIPT_TYPES) {
      const once = reduceOutcome(NO_OUTCOME, receipt(type));
      const twice = reduceOutcome(once.next, receipt(type));
      expect(twice.changed).toBe(false);
      expect(twice.next).toEqual(once.next);
    }
  });

  it("the result does not depend on arrival order (commutative), for every ordering of every combination", () => {
    const subsets: ReceiptType[][] = [];
    for (let mask = 1; mask < 1 << RECEIPT_TYPES.length; mask++) {
      subsets.push(RECEIPT_TYPES.filter((_, i) => mask & (1 << i)));
    }
    for (const subset of subsets) {
      const reference = foldReceipts(subset.map(receipt));
      for (const order of perms(subset)) {
        expect(foldReceipts(order.map(receipt))).toEqual(reference);
      }
    }
  });

  it("duplicates mixed into any order still give the same result", () => {
    const base: ReceiptType[] = ["accepted", "delivered", "bounced"];
    const reference = foldReceipts(base.map(receipt));
    for (const order of perms([
      "accepted",
      "accepted",
      "delivered",
      "bounced",
      "delivered",
      "bounced",
    ] as ReceiptType[])) {
      expect(foldReceipts(order.map(receipt))).toEqual(reference);
    }
  });

  it("never gets weaker: no receipt lowers the level, whatever arrives later", () => {
    const rank = { none: 0, accepted: 1, delivered: 2, negative: 3 } as const;
    for (const first of perms([...RECEIPT_TYPES])) {
      let state: DeliveryOutcome = NO_OUTCOME;
      for (const type of first) {
        const { next } = reduceOutcome(state, receipt(type));
        expect(rank[next.level]).toBeGreaterThanOrEqual(rank[state.level]);
        state = next;
      }
    }
  });

  it("a late 'accepted' cannot undo a delivery, and a late 'delivered' cannot undo a bounce", () => {
    const delivered = foldReceipts([receipt("delivered")]);
    expect(reduceOutcome(delivered, receipt("accepted"))).toMatchObject({ changed: false });
    const bounced = foldReceipts([receipt("accepted"), receipt("bounced")]);
    const late = reduceOutcome(bounced, receipt("delivered"));
    expect(late.changed).toBe(false);
    expect(late.next).toEqual(bounced);
    expect(isConfirmedDelivery(late.next)).toBe(false);
  });

  it("an asynchronous bounce AFTER a delivery receipt wins (bounces really arrive late)", () => {
    const outcome = foldReceipts([receipt("accepted"), receipt("delivered"), receipt("bounced")]);
    expect(outcome).toMatchObject({ level: "negative", negative: "bounced" });
    expect(isConfirmedDelivery(outcome)).toBe(false);
    expect(describeOutcome(outcome)).toMatch(/bounced/i);
  });

  it("bounced and rejected resolve by a fixed precedence, not by who arrived first", () => {
    expect(foldReceipts([receipt("rejected"), receipt("bounced")])).toEqual(
      foldReceipts([receipt("bounced"), receipt("rejected")]),
    );
    expect(foldReceipts([receipt("rejected")])).toMatchObject({ negative: "rejected" });
    expect(describeOutcome(foldReceipts([receipt("rejected")]))).toMatch(/rejected/i);
  });

  it("a complaint is its own fact and also proves delivery; it never overrides a bounce", () => {
    const complained = foldReceipts([receipt("complained")]);
    expect(complained).toMatchObject({ level: "delivered", complained: true });
    expect(describeOutcome(complained)).toMatch(/spam/i);
    expect(foldReceipts([receipt("bounced"), receipt("complained")])).toMatchObject({
      level: "negative",
      complained: true,
    });
    expect(foldReceipts([receipt("complained"), receipt("accepted")])).toMatchObject({
      level: "delivered",
      complained: true,
    });
  });

  it("the outcome is a function of the receipts only: the send's SENT status has no say", () => {
    // `isConfirmedDelivery` takes an outcome, not a status: SENT (provider acceptance) cannot be passed to it.
    expect(isConfirmedDelivery({ level: "accepted", negative: null, complained: false })).toBe(
      false,
    );
  });
});

describe("correlateReceipt: tenant-safe, exactly one send or nothing", () => {
  const sendA = { id: SEND_A, organizationId: ORG_A, providerMessageId: "pm-1" };
  const sendB = { id: SEND_B, organizationId: ORG_B, providerMessageId: "pm-2" };

  it("matches the one send with that provider message id and uses ITS organization", () => {
    const result = correlateReceipt({ providerMessageId: "pm-1", sendId: null }, [sendA, sendB]);
    expect(result).toEqual({ ok: true, send: sendA });
    expect(result.ok && result.send.organizationId).toBe(ORG_A);
  });

  it("an unknown provider message id is unmatched: it creates nothing and touches nothing", () => {
    expect(correlateReceipt({ providerMessageId: "pm-404", sendId: null }, [sendA, sendB])).toEqual(
      { ok: false, reason: "unmatched" },
    );
    expect(correlateReceipt({ providerMessageId: "pm-1", sendId: null }, [])).toEqual({
      ok: false,
      reason: "unmatched",
    });
  });

  it("the same provider message id on sends of two organizations is ambiguous: quarantined, never guessed", () => {
    const clash = { id: SEND_B, organizationId: ORG_B, providerMessageId: "pm-1" };
    expect(correlateReceipt({ providerMessageId: "pm-1", sendId: null }, [sendA, clash])).toEqual({
      ok: false,
      reason: "ambiguous",
    });
  });

  it("a send id the provider echoes must agree with the match", () => {
    expect(correlateReceipt({ providerMessageId: "pm-1", sendId: SEND_A }, [sendA]).ok).toBe(true);
    expect(correlateReceipt({ providerMessageId: "pm-1", sendId: SEND_B }, [sendA])).toEqual({
      ok: false,
      reason: "mismatch",
    });
  });

  it("a send without a provider message id (not yet accepted) can never be matched", () => {
    expect(
      correlateReceipt({ providerMessageId: "pm-1", sendId: null }, [
        { id: SEND_A, organizationId: ORG_A, providerMessageId: null },
      ]),
    ).toEqual({ ok: false, reason: "unmatched" });
  });
});
