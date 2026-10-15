import { describe, expect, it } from "vitest";
import { NO_SENDING_GUARANTEES, sendingCapabilities } from "./fake-provider";
import {
  FINAL_STATUSES,
  LEASE_MARGIN_MS,
  OUTBOUND_POLICY,
  TRANSITIONS,
  backoffMs,
  canTransition,
  decideAfterAttempt,
  decideAmbiguous,
  leaseFor,
  reconciliationMode,
  requiredKeyRetentionMs,
  retryHorizonMs,
  sanitizeErrorCode,
  settleWindowMs,
  type OutboundStatus,
} from "./outbound-state";
import { buildThreading } from "./outbound";

const ALL: OutboundStatus[] = [
  "PENDING",
  "PROCESSING",
  "SENT",
  "RETRY_SCHEDULED",
  "FAILED",
  "UNKNOWN",
];

describe("state machine", () => {
  it("allows exactly the documented transitions", () => {
    const allowed = ALL.flatMap((from) =>
      ALL.filter((to) => canTransition(from, to)).map((to) => `${from}>${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        "PENDING>PROCESSING",
        "RETRY_SCHEDULED>PROCESSING",
        "PROCESSING>PROCESSING",
        "PROCESSING>SENT",
        "PROCESSING>RETRY_SCHEDULED",
        "PROCESSING>FAILED",
        "PROCESSING>UNKNOWN",
        "UNKNOWN>SENT",
        "UNKNOWN>FAILED",
      ].sort(),
    );
  });

  it("SENT and FAILED are final: nothing leaves them", () => {
    for (const status of FINAL_STATUSES) expect(TRANSITIONS[status]).toEqual([]);
  });

  it("a send can only be tried from a waiting state, and UNKNOWN never goes back to a retry", () => {
    expect(canTransition("PENDING", "SENT")).toBe(false);
    expect(canTransition("PENDING", "RETRY_SCHEDULED")).toBe(false);
    expect(canTransition("UNKNOWN", "PROCESSING")).toBe(false);
    expect(canTransition("UNKNOWN", "RETRY_SCHEDULED")).toBe(false);
    expect(canTransition("UNKNOWN", "PENDING")).toBe(false);
  });
});

describe("backoffMs", () => {
  const middle = () => 0.5; // jitter factor exactly 1

  it("doubles from the base and is capped", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, middle))).toEqual([
      30_000, 60_000, 120_000, 240_000,
    ]);
    expect(backoffMs(30, middle)).toBe(OUTBOUND_POLICY.capMs);
    expect(backoffMs(1000, middle)).toBe(OUTBOUND_POLICY.capMs);
  });

  it("jitters by at most +-20% so failures that started together do not retry together", () => {
    expect(backoffMs(2, () => 0)).toBe(Math.round(60_000 * 0.8));
    expect(backoffMs(2, () => 0.999999)).toBeLessThanOrEqual(Math.round(60_000 * 1.2));
    const samples = new Set(Array.from({ length: 50 }, (_, i) => backoffMs(3, () => i / 50)));
    expect(samples.size).toBeGreaterThan(10);
  });

  it("is never negative or zero, even for nonsense input", () => {
    expect(backoffMs(0, middle)).toBeGreaterThanOrEqual(1_000);
    expect(backoffMs(-5, middle)).toBeGreaterThanOrEqual(1_000);
  });
});

describe("sanitizeErrorCode", () => {
  it.each([
    ["rate_limited", "rate_limited"],
    ["Mailbox full: user@example.com", "provider_error"],
    ["", "provider_error"],
    ["x".repeat(65), "provider_error"],
    ["UPPER", "provider_error"],
    [null, "provider_error"],
    [42, "provider_error"],
  ])("%j -> %s", (input, expected) => {
    expect(sanitizeErrorCode(input)).toBe(expected);
  });
});

describe("decideAfterAttempt", () => {
  it("success -> SENT with the provider id", () => {
    expect(decideAfterAttempt({ ok: true, providerMessageId: "pm-1" }, 1)).toEqual({
      to: "SENT",
      providerMessageId: "pm-1",
    });
  });

  it("a permanent failure is final and never retried, whatever the attempt number", () => {
    for (const attempt of [1, 3, 6]) {
      expect(
        decideAfterAttempt({ ok: false, retryable: false, code: "mailbox_invalid" }, attempt),
      ).toEqual({
        to: "FAILED",
        code: "mailbox_invalid",
        reason: "permanent",
      });
    }
  });

  it("a retryable failure is rescheduled with backoff until the attempts run out", () => {
    const middle = () => 0.5;
    expect(
      decideAfterAttempt({ ok: false, retryable: true, code: "rate_limited" }, 1, middle),
    ).toEqual({
      to: "RETRY_SCHEDULED",
      code: "rate_limited",
      delayMs: 30_000,
    });
    expect(
      decideAfterAttempt(
        { ok: false, retryable: true, code: "rate_limited" },
        OUTBOUND_POLICY.maxAttempts,
        middle,
      ),
    ).toEqual({ to: "FAILED", code: "rate_limited", reason: "retries_exhausted" });
  });

  it("never stores provider text: an unsafe code becomes a generic one", () => {
    const decision = decideAfterAttempt(
      { ok: false, retryable: false, code: "550 5.1.1 bob@x.test unknown" },
      1,
    );
    expect(decision).toMatchObject({ code: "provider_error" });
  });
});

const MIN = 60_000;
const none = NO_SENDING_GUARANTEES;
/** Idempotent only: a same-key retry cannot duplicate; no lookup. */
const idem = sendingCapabilities({
  lookupByKey: false,
  lookupConsistency: "none",
  lookupSettleMs: null,
  lookupRetentionMs: null,
});
/** An authoritative lookup that is immediately consistent and with no late acceptance: "not found" is final at once. */
const strongLookup = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
/** An eventually consistent lookup and a request that may still land 3 minutes after it was sent. */
const eventual = sendingCapabilities({
  idempotentByKey: false,
  keyRetentionMs: null,
  lookupConsistency: "eventual",
  lookupSettleMs: 2 * MIN,
  lateAcceptanceCeilingMs: 3 * MIN,
  lookupRetentionMs: 24 * 60 * MIN,
});
const both = sendingCapabilities();

describe("reconciliationMode and settleWindowMs: derived from declarations, defensive when they are missing or weak", () => {
  it("idempotent only with a key memory that covers the whole retry horizon", () => {
    expect(reconciliationMode(both)).toBe("idempotent");
    expect(reconciliationMode({ ...both, keyRetentionMs: null })).toBe("lookup");
    expect(reconciliationMode({ ...both, keyRetentionMs: requiredKeyRetentionMs() - 1 })).toBe(
      "lookup",
    );
    expect(reconciliationMode({ ...idem, keyRetentionMs: requiredKeyRetentionMs() - 1 })).toBe(
      "none",
    );
    expect(reconciliationMode({ ...idem, keyRetentionMs: Number.NaN })).toBe("none");
  });

  it("a lookup counts only with a stated consistency, retention and late-acceptance bound", () => {
    expect(reconciliationMode(strongLookup)).toBe("lookup");
    expect(reconciliationMode(eventual)).toBe("lookup");
    for (const broken of [
      { lookupConsistency: "none" as const },
      { lookupRetentionMs: null },
      { lookupRetentionMs: 0 },
      { lateAcceptanceCeilingMs: null },
    ]) {
      expect(reconciliationMode({ ...strongLookup, ...broken })).toBe("none");
    }
    expect(reconciliationMode({ ...eventual, lookupSettleMs: null })).toBe("none");
    expect(reconciliationMode({ ...eventual, lookupSettleMs: 0 })).toBe("none");
    expect(reconciliationMode(none)).toBe("none");
  });

  it("the settle window is the late-acceptance ceiling plus the lookup lag, and only for lookup mode", () => {
    expect(settleWindowMs(eventual)).toBe(5 * MIN);
    expect(settleWindowMs(strongLookup)).toBe(0);
    expect(settleWindowMs({ ...strongLookup, lateAcceptanceCeilingMs: 45_000 })).toBe(45_000);
    expect(settleWindowMs(both)).toBe(0);
    expect(settleWindowMs(none)).toBe(0);
  });

  it("the lease always covers the settle window plus the call and the lookup timeouts", () => {
    expect(leaseFor(both)).toBe(OUTBOUND_POLICY.leaseMs);
    const lease = leaseFor(eventual);
    expect(lease).toBeGreaterThanOrEqual(
      settleWindowMs(eventual) + 2 * OUTBOUND_POLICY.sendTimeoutMs + LEASE_MARGIN_MS,
    );
    expect(leaseFor(eventual, 10_000)).toBeLessThan(lease);
  });

  it("the retry horizon is bounded and the required key memory is twice it", () => {
    expect(retryHorizonMs()).toBeGreaterThan(10 * MIN);
    expect(retryHorizonMs()).toBeLessThan(2 * 60 * MIN);
    expect(requiredKeyRetentionMs()).toBe(2 * retryHorizonMs());
  });
});

describe("decideAmbiguous: an unknown outcome is never resent blindly and never recorded as sent without proof", () => {
  const base = {
    code: "timeout",
    attempt: 1,
    random: () => 0.5,
    settledForMs: 10 * 60 * MIN,
    sinceClaimMs: 10 * 60 * MIN,
  };

  it("an authoritative lookup that FINDS the send -> SENT (proof), whatever the provider promises", () => {
    for (const capabilities of [none, idem, strongLookup, eventual, both]) {
      expect(
        decideAmbiguous({
          ...base,
          settledForMs: 0,
          capabilities,
          lookup: { status: "found", providerMessageId: "pm-9" },
        }),
      ).toEqual({ to: "SENT", providerMessageId: "pm-9" });
    }
  });

  it("'not found' from a strongly consistent lookup makes a retry safe", () => {
    expect(
      decideAmbiguous({ ...base, capabilities: strongLookup, lookup: { status: "not_found" } }),
    ).toMatchObject({ to: "RETRY_SCHEDULED" });
  });

  it("'not found' BEFORE the settle window has passed proves nothing: the send stays pending, never resent", () => {
    const decision = decideAmbiguous({
      ...base,
      capabilities: eventual,
      lookup: { status: "not_found" },
      settledForMs: 45_000,
    });
    expect(decision).toEqual({
      to: "AWAIT_SETTLE",
      code: "timeout",
      remainingMs: settleWindowMs(eventual) - 45_000,
    });
  });

  it("the same 'not found' is believed once the window has passed, and exactly at it", () => {
    for (const settledForMs of [settleWindowMs(eventual), settleWindowMs(eventual) + 1]) {
      expect(
        decideAmbiguous({
          ...base,
          capabilities: eventual,
          lookup: { status: "not_found" },
          settledForMs,
        }),
      ).toMatchObject({ to: "RETRY_SCHEDULED" });
    }
    expect(
      decideAmbiguous({
        ...base,
        capabilities: eventual,
        lookup: { status: "not_found" },
        settledForMs: settleWindowMs(eventual) - 1,
      }).to,
    ).toBe("AWAIT_SETTLE");
  });

  it("'not found' after the lookup's retention is only 'forgotten': UNKNOWN, never a retry", () => {
    const retention = eventual.lookupRetentionMs!;
    expect(
      decideAmbiguous({
        ...base,
        capabilities: eventual,
        lookup: { status: "not_found" },
        sinceClaimMs: retention + 1,
      }),
    ).toEqual({ to: "UNKNOWN", code: "timeout" });
    expect(
      decideAmbiguous({
        ...base,
        capabilities: eventual,
        lookup: { status: "not_found" },
        sinceClaimMs: retention,
      }).to,
    ).toBe("RETRY_SCHEDULED");
  });

  it("a 'not found' from a provider that does not promise an authoritative lookup proves nothing", () => {
    expect(
      decideAmbiguous({ ...base, capabilities: none, lookup: { status: "not_found" } }),
    ).toEqual({ to: "UNKNOWN", code: "timeout" });
  });

  it("a lookup with missing consistency / retention / ceiling declarations is not trusted either", () => {
    for (const broken of [
      { lookupConsistency: "none" as const },
      { lookupRetentionMs: null },
      { lateAcceptanceCeilingMs: null },
    ]) {
      expect(
        decideAmbiguous({
          ...base,
          capabilities: { ...strongLookup, ...broken },
          lookup: { status: "not_found" },
        }),
      ).toEqual({ to: "UNKNOWN", code: "timeout" });
    }
  });

  it("not found on the last attempt (after the window) is a truthful final failure (nothing was accepted)", () => {
    expect(
      decideAmbiguous({
        ...base,
        attempt: OUTBOUND_POLICY.maxAttempts,
        capabilities: strongLookup,
        lookup: { status: "not_found" },
      }),
    ).toMatchObject({ to: "FAILED", reason: "retries_exhausted" });
  });

  it("an idempotent provider with a long enough key memory makes a same-key retry safe, even without a lookup", () => {
    for (const lk of [null, { status: "unavailable" as const }]) {
      expect(
        decideAmbiguous({ ...base, settledForMs: 0, capabilities: idem, lookup: lk }),
      ).toMatchObject({ to: "RETRY_SCHEDULED" });
    }
  });

  it("an idempotent provider whose key memory is shorter than the retry horizon is NOT trusted", () => {
    expect(
      decideAmbiguous({
        ...base,
        capabilities: { ...idem, keyRetentionMs: requiredKeyRetentionMs() - 1 },
        lookup: null,
      }),
    ).toEqual({ to: "UNKNOWN", code: "timeout" });
  });

  it("an idempotent provider with the outcome still unconfirmed on the last attempt stays UNKNOWN, never FAILED", () => {
    expect(
      decideAmbiguous({
        ...base,
        attempt: OUTBOUND_POLICY.maxAttempts,
        capabilities: idem,
        lookup: null,
      }),
    ).toEqual({ to: "UNKNOWN", code: "timeout" });
  });

  it("with neither idempotency nor lookup it is UNKNOWN: no resend, no 'sent', no 'failed'", () => {
    for (const lk of [null, { status: "unavailable" as const }]) {
      expect(decideAmbiguous({ ...base, capabilities: none, lookup: lk })).toEqual({
        to: "UNKNOWN",
        code: "timeout",
      });
    }
  });

  it("a lookup that is unavailable on a lookup-only provider is not an answer", () => {
    expect(
      decideAmbiguous({ ...base, capabilities: strongLookup, lookup: { status: "unavailable" } }),
    ).toEqual({ to: "UNKNOWN", code: "timeout" });
  });

  it("the whole decision space: nothing is retried or failed on an ambiguous outcome without an idempotent provider or a settled, retained, authoritative not-found", () => {
    const lookups = [null, { status: "unavailable" as const }, { status: "not_found" as const }];
    const settles = [0, settleWindowMs(eventual) - 1, settleWindowMs(eventual), 10 * 60 * MIN];
    const claims = [0, eventual.lookupRetentionMs!, eventual.lookupRetentionMs! + 1];
    for (const capabilities of [none, idem, strongLookup, eventual, both]) {
      for (const lk of lookups) {
        for (const attempt of [1, OUTBOUND_POLICY.maxAttempts]) {
          for (const settledForMs of settles) {
            for (const sinceClaimMs of claims) {
              const decision = decideAmbiguous({
                ...base,
                attempt,
                capabilities,
                lookup: lk,
                settledForMs,
                sinceClaimMs,
              });
              expect(decision.to).not.toBe("SENT");
              const mode = reconciliationMode(capabilities);
              if (decision.to === "RETRY_SCHEDULED" || decision.to === "FAILED") {
                const lookupProof =
                  mode === "lookup" &&
                  lk?.status === "not_found" &&
                  settledForMs >= settleWindowMs(capabilities) &&
                  sinceClaimMs <= (capabilities.lookupRetentionMs ?? 0);
                if (decision.to === "FAILED") expect(lookupProof).toBe(true);
                else expect(mode === "idempotent" || lookupProof).toBe(true);
              }
            }
          }
        }
      }
    }
  });
});

describe("buildThreading (newest first in, derived only from recorded Message-IDs)", () => {
  const row = (id: string | null, direction: "INBOUND" | "OUTBOUND") => ({
    rfcMessageId: id,
    direction,
  });

  it("a conversation with no recorded ids starts a fresh thread: no In-Reply-To, no References", () => {
    expect(buildThreading([])).toEqual({ inReplyTo: null, references: [] });
    expect(buildThreading([row(null, "INBOUND"), row("not an id", "INBOUND")])).toEqual({
      inReplyTo: null,
      references: [],
    });
  });

  it("replies to the customer's newest message and lists the chain oldest to newest, ending with it", () => {
    const out = buildThreading([
      row("<c2@x>", "INBOUND"),
      row("<o1@p>", "OUTBOUND"),
      row("<c1@x>", "INBOUND"),
    ]);
    expect(out).toEqual({ inReplyTo: "<c2@x>", references: ["<c1@x>", "<o1@p>", "<c2@x>"] });
  });

  it("with only our own earlier emails it replies to the newest of them", () => {
    expect(buildThreading([row("<o2@p>", "OUTBOUND"), row("<o1@p>", "OUTBOUND")])).toEqual({
      inReplyTo: "<o2@p>",
      references: ["<o1@p>", "<o2@p>"],
    });
  });

  it("bounds References to 20 ids and drops duplicates and malformed ids", () => {
    const many = Array.from({ length: 40 }, (_, i) => row(`<m${40 - i}@x>`, "INBOUND"));
    const { references, inReplyTo } = buildThreading([
      row("<m40@x>", "INBOUND"),
      ...many,
      row("junk", "INBOUND"),
    ]);
    expect(references).toHaveLength(20);
    expect(references.at(-1)).toBe(inReplyTo);
    expect(new Set(references).size).toBe(references.length);
  });
});
