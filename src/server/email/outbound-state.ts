import type { SendLookup, SendResult, SendingCapabilities } from "./provider";

/**
 * The outbound email state machine and retry policy: pure functions, no I/O, so every rule is unit-testable.
 * The service (`outbound.ts`) applies these decisions with conditional database updates; the table
 * `outbound_emails` is the only source of truth.
 *
 * EXECUTION MODEL. Delivery is AT-LEAST-ONCE at the worker level: a queue job may run twice, two workers may
 * race, a worker may die at any point. The platform never claims EXACTLY-ONCE delivery to the customer. It makes a
 * duplicate external email impossible in the cases it controls and keeps the remaining case visible:
 *
 *   - one logical send = one row (unique per message); the send id is the provider idempotency key;
 *   - an attempt is CLAIMED with one atomic conditional update (status + attempts) BEFORE the provider is called, so
 *     concurrent workers cannot both call it for the same attempt;
 *   - finalizing is fenced by the attempt number, so a stale worker cannot overwrite a newer attempt;
 *   - the provider is only ever called again after an AMBIGUOUS outcome when that cannot duplicate: the provider is
 *     idempotent by key (and remembers keys for the whole retry horizon), or an authoritative lookup says nothing was
 *     accepted AFTER the settle window (the time a timed-out request may still be accepted plus the lookup's own
 *     lag) and while the lookup still remembers; otherwise the email stays UNKNOWN. A request that was abandoned is
 *     never assumed cancelled.
 *
 * The residual risk, stated plainly: with a provider that is neither idempotent nor queryable, an ambiguous outcome
 * can mean the customer received the email while we record UNKNOWN (never "failed", never a blind resend), and an
 * operator decides. With an idempotent provider the guarantee is only as strong as the provider's key memory.
 */

export type OutboundStatus =
  "PENDING" | "PROCESSING" | "SENT" | "RETRY_SCHEDULED" | "FAILED" | "UNKNOWN";

/** Allowed transitions. Anything else is a bug and is refused by the repository's conditional updates. */
export const TRANSITIONS: Record<OutboundStatus, readonly OutboundStatus[]> = {
  PENDING: ["PROCESSING"],
  RETRY_SCHEDULED: ["PROCESSING"],
  // PROCESSING -> PROCESSING is the takeover of a crashed attempt's expired lease (attempts + 1, new lease).
  PROCESSING: ["PROCESSING", "SENT", "RETRY_SCHEDULED", "FAILED", "UNKNOWN"],
  // Confirmed later (a delivery receipt, an operator); never an automatic resend.
  UNKNOWN: ["SENT", "FAILED"],
  SENT: [],
  FAILED: [],
};

export function canTransition(from: OutboundStatus, to: OutboundStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export const FINAL_STATUSES: readonly OutboundStatus[] = ["SENT", "FAILED"];

// ---- timing --------------------------------------------------------------------------------------------

export const OUTBOUND_POLICY = {
  /** Attempts (claims) before a retryable failure becomes final. */
  maxAttempts: 6,
  /** First retry delay; doubles each attempt up to `capMs`. */
  baseDelayMs: 30_000,
  capMs: 60 * 60 * 1000,
  /** +-20% so many sends that failed together do not retry together. */
  jitter: 0.2,
  /** A claim is valid this long; after it the attempt is treated as an unknown outcome. */
  leaseMs: 2 * 60 * 1000,
  /** The worker gives up waiting for the provider after this and treats the outcome as ambiguous. */
  sendTimeoutMs: 45_000,
} as const;

/** Delay before the next attempt, after `failedAttempts` attempts: bounded exponential backoff with jitter. */
export function backoffMs(failedAttempts: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(failedAttempts - 1, 20));
  const base = Math.min(OUTBOUND_POLICY.capMs, OUTBOUND_POLICY.baseDelayMs * 2 ** exponent);
  const factor = 1 + OUTBOUND_POLICY.jitter * (2 * random() - 1);
  return Math.max(1_000, Math.round(base * factor));
}

/** Provider codes are stored and logged only as short machine codes, never as provider text. */
export function sanitizeErrorCode(code: unknown): string {
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/.test(code) ? code : "provider_error";
}

// ---- decisions ----------------------------------------------------------------------------------------

/** Why a FAILED send is final. The last two are decided before the provider is ever called. */
export type FailureReason =
  "permanent" | "retries_exhausted" | "sender_unavailable" | "message_missing";

export type Decision =
  | { to: "SENT"; providerMessageId: string }
  /** `noCall`: no provider request was made by the attempt (so the retry budget is not used). */
  | { to: "RETRY_SCHEDULED"; code: string; delayMs: number; noCall?: boolean }
  | { to: "FAILED"; code: string; reason: FailureReason }
  | { to: "UNKNOWN"; code: string }
  /**
   * Not a state change. The lookup said "not found", but not enough time has passed for that to prove anything (the
   * request may still be accepted, or the lookup may still be catching up). The send stays PROCESSING; its lease runs
   * out only after the settle window (see `leaseFor`), and recovery asks again then.
   */
  | { to: "AWAIT_SETTLE"; code: string; remainingMs: number };

/** A decision that changes state (AWAIT_SETTLE does not: the send simply stays PROCESSING). */
export type FinalDecision = Exclude<Decision, { to: "AWAIT_SETTLE" }>;

function retryOrExhaust(
  code: string,
  attempt: number,
  random: () => number,
  maxAttempts: number,
): FinalDecision {
  return attempt >= maxAttempts
    ? { to: "FAILED", code, reason: "retries_exhausted" }
    : { to: "RETRY_SCHEDULED", code, delayMs: backoffMs(attempt, random) };
}

/**
 * What to do with the result of attempt number `attempt` (1-based). A definite failure is retried only when the
 * provider said it is retryable; a permanent one is final. An AMBIGUOUS result is not decided here: it needs
 * `decideAmbiguous` (with a lookup when the provider supports one).
 */
export function decideAfterAttempt(
  result: Exclude<SendResult, { ok: false; ambiguous: true }>,
  attempt: number,
  random: () => number = Math.random,
  maxAttempts: number = OUTBOUND_POLICY.maxAttempts,
): FinalDecision {
  if (result.ok) return { to: "SENT", providerMessageId: result.providerMessageId };
  const code = sanitizeErrorCode(result.code);
  if (!result.retryable) return { to: "FAILED", code, reason: "permanent" };
  return retryOrExhaust(code, attempt, random, maxAttempts);
}

// ---- reconciliation policy (derived from what a provider declares) -----------------------------------------

/** Safety margin on every lease: clock differences between workers, DB latency between claim and call. */
export const LEASE_MARGIN_MS = 30_000;

/** The longest the platform keeps retrying one send, counted from the first claim (jitter, timeouts, leases included). */
export function retryHorizonMs(maxAttempts: number = OUTBOUND_POLICY.maxAttempts): number {
  let total = 0;
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    const base = Math.min(OUTBOUND_POLICY.capMs, OUTBOUND_POLICY.baseDelayMs * 2 ** (attempt - 1));
    total += base * (1 + OUTBOUND_POLICY.jitter);
  }
  return Math.ceil(total + maxAttempts * (OUTBOUND_POLICY.leaseMs + OUTBOUND_POLICY.sendTimeoutMs));
}

/** A provider's key memory must cover the retry horizon twice over (a retry may be recovered late). */
export function requiredKeyRetentionMs(maxAttempts: number = OUTBOUND_POLICY.maxAttempts): number {
  return 2 * retryHorizonMs(maxAttempts);
}

function isDuration(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Whether a "not found" from this provider's lookup can mean anything: it must be an authoritative lookup with a stated
 * consistency, a retention and a bound on how late a request may still be accepted. Anything unstated is distrusted.
 */
export function lookupTrusted(c: SendingCapabilities): boolean {
  return (
    c.lookupByKey &&
    (c.lookupConsistency === "strong" || c.lookupConsistency === "eventual") &&
    isDuration(c.lookupRetentionMs) &&
    c.lookupRetentionMs > 0 &&
    isDuration(c.lateAcceptanceCeilingMs) &&
    (c.lookupConsistency === "strong" || (isDuration(c.lookupSettleMs) && c.lookupSettleMs > 0))
  );
}

/**
 * How an AMBIGUOUS outcome may be resolved with this provider, decided from its declarations. Deliberately defensive:
 * a declaration that is missing, unknown or too weak degrades to the SAFEST mode instead of being trusted
 * (`provider-policy.ts` additionally refuses to select such a provider at all).
 *
 *  - "idempotent": a retry with the same key cannot duplicate (and the key outlives the retry horizon);
 *  - "lookup": an authoritative lookup can prove "not accepted", but only after `settleWindowMs` and within retention;
 *  - "none": never retry automatically; the send stays UNKNOWN.
 */
export function reconciliationMode(
  c: SendingCapabilities,
  maxAttempts: number = OUTBOUND_POLICY.maxAttempts,
): "idempotent" | "lookup" | "none" {
  if (
    c.idempotentByKey &&
    isDuration(c.keyRetentionMs) &&
    c.keyRetentionMs >= requiredKeyRetentionMs(maxAttempts)
  ) {
    return "idempotent";
  }
  if (lookupTrusted(c)) return "lookup";
  return "none";
}

/**
 * How long, from the moment a request is sent, before a "not found" can be believed: the request may still be accepted
 * for `lateAcceptanceCeilingMs`, and an accepted send may stay invisible for `lookupSettleMs` after that.
 * 0 when the lookup is not trusted at all (then a "not found" is never believed, whatever the time).
 */
export function settleWindowMs(c: SendingCapabilities): number {
  if (!lookupTrusted(c)) return 0;
  const lag = c.lookupConsistency === "eventual" ? (c.lookupSettleMs ?? 0) : 0;
  return (c.lateAcceptanceCeilingMs ?? 0) + lag;
}

/**
 * How long one claim stays valid. A provider call may only START while at least `settleWindowMs` of the lease remains
 * (`attemptDelivery`), so by the time ANY lease has expired every call made under it has had the whole settle window:
 * "lease expired" therefore means "a not-found lookup is now believable". The lease also covers the call and the
 * lookup's own timeouts.
 */
export function leaseFor(
  c: SendingCapabilities,
  sendTimeoutMs: number = OUTBOUND_POLICY.sendTimeoutMs,
): number {
  return Math.max(OUTBOUND_POLICY.leaseMs, settleWindowMs(c) + 2 * sendTimeoutMs + LEASE_MARGIN_MS);
}

/**
 * An attempt whose outcome is UNKNOWN: the provider call was ambiguous (timeout, lost response) OR the worker died
 * between claiming and recording (lease expired). The provider may have accepted the email, and (the request is not
 * cancelled) may STILL accept it. The order of safety:
 *
 *   1. an authoritative lookup that FINDS the key -> SENT (it was accepted);
 *   2. the provider is idempotent by key and remembers keys for the whole retry horizon -> retry with the SAME key
 *      (a duplicate, even a late one, is refused by the provider);
 *   3. an authoritative lookup that says NOT FOUND is believed only when
 *        - at least `settleWindowMs` have passed since the request was sent (`settledForMs`): before that the request
 *          may still be accepted or the lookup may still be catching up -> AWAIT_SETTLE, no change of state;
 *        - the lookup still remembers (`sinceClaimMs` within `lookupRetentionMs`): after that "not found" is only
 *          "forgotten" -> UNKNOWN;
 *   4. otherwise -> UNKNOWN, kept for an operator. NEVER a blind resend.
 *
 * `settledForMs` is a lower bound of the time since the request was sent; `sinceClaimMs` an upper bound (time since
 * the attempt was claimed). `lookup` is null when the provider has no lookup or it was not asked. "unavailable" is not
 * an answer: it falls through to 4.
 */
export function decideAmbiguous(input: {
  code: string;
  lookup: SendLookup | null;
  capabilities: SendingCapabilities;
  attempt: number;
  settledForMs: number;
  sinceClaimMs: number;
  random?: () => number;
  maxAttempts?: number;
}): Decision {
  const { lookup, capabilities, attempt } = input;
  const random = input.random ?? Math.random;
  const maxAttempts = input.maxAttempts ?? OUTBOUND_POLICY.maxAttempts;
  const code = sanitizeErrorCode(input.code);

  if (lookup?.status === "found")
    return { to: "SENT", providerMessageId: lookup.providerMessageId };

  const mode = reconciliationMode(capabilities, maxAttempts);
  if (mode === "idempotent") {
    // Out of attempts with the outcome still unconfirmed: we cannot truthfully say "failed" (the customer may
    // have received it), so it stays UNKNOWN for an operator rather than becoming a final failure.
    return attempt >= maxAttempts
      ? { to: "UNKNOWN", code }
      : { to: "RETRY_SCHEDULED", code, delayMs: backoffMs(attempt, random) };
  }
  if (mode === "lookup" && lookup?.status === "not_found") {
    if (input.sinceClaimMs > (capabilities.lookupRetentionMs ?? 0)) return { to: "UNKNOWN", code };
    const window = settleWindowMs(capabilities);
    if (input.settledForMs < window) {
      return { to: "AWAIT_SETTLE", code, remainingMs: window - input.settledForMs };
    }
    return retryOrExhaust(code, attempt, random, maxAttempts);
  }
  return { to: "UNKNOWN", code };
}
