/**
 * The replay and retry facts of ONE provider, declared by its adapter and checked by the contract tests.
 *
 * Two different time windows protect against two different things, and they must fit together:
 *
 *  - `freshnessSeconds`: `verifyWebhook` refuses a notification whose signed timestamp is older (or newer) than
 *    this. It limits how long a captured request stays replayable.
 *  - `retryHorizonSeconds`: how long the provider keeps re-sending a notification that was not acknowledged
 *    with 2xx (documented, not measured).
 *
 * THE INVARIANT: if the provider re-sends the ORIGINAL signed request (same timestamp), the freshness window
 * must be at least as long as the retry horizon, otherwise the provider's own retries are refused as stale and
 * the message is lost. If instead every retry is freshly signed (`retriesResigned`), the window can be short.
 *
 * The replay ledger must outlive everything that could present the same notification again, so its retention is
 * derived from this policy (see `requiredLedgerRetentionDays`), never guessed.
 */
export type ReplayPolicy = {
  freshnessSeconds: number;
  retryHorizonSeconds: number;
  /** Each retry carries a new signature and timestamp (so an old timestamp never reaches us). */
  retriesResigned: boolean;
};

export function assertReplayPolicy(policy: ReplayPolicy): void {
  const ok = (n: number) => Number.isInteger(n) && n >= 0;
  if (!Number.isInteger(policy.freshnessSeconds) || policy.freshnessSeconds <= 0) {
    throw new Error("replay policy: freshnessSeconds must be a positive integer");
  }
  if (!ok(policy.retryHorizonSeconds)) {
    throw new Error("replay policy: retryHorizonSeconds must be a non-negative integer");
  }
  if (!policy.retriesResigned && policy.freshnessSeconds < policy.retryHorizonSeconds) {
    throw new Error(
      "replay policy: the provider re-sends the original signed request, so freshnessSeconds must cover its retry horizon or retries will be refused as stale",
    );
  }
}

/** The minimum ledger retention (whole days, at least 1) for a policy: twice the longest possible replay span. */
export function requiredLedgerRetentionDays(policy: ReplayPolicy): number {
  const span = policy.freshnessSeconds + policy.retryHorizonSeconds;
  return Math.max(1, Math.ceil((2 * span) / 86_400));
}
