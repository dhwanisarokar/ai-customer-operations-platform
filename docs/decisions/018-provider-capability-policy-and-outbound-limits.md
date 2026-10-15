# 018 - Provider capability policy, settle-window reconciliation and database-backed outbound limits

Status: accepted (Phase 9.6, fake provider only)

## Context

The 9.5 audit found that an immediate "not found" from a provider lookup was treated as proof that nothing had been accepted, so an
ambiguous send could be resent about 30 seconds later while the original request was still in flight or the lookup still catching up. It
also found that provider capabilities were two booleans, that nothing separated "declared" from "verified", and that nothing limited how
much email staff (or a compromised account) could cause.

## Decision

1. **Capabilities are explicit numbers** (`SendingCapabilities`): key retention, lookup consistency, lookup settle lag, lookup retention
   and the late-acceptance ceiling, with `null` meaning unknown and unknown meaning no guarantee. `ProviderReadiness` separates
   `fake` / `declared` / `verified`; production accepts only `verified` with evidence.
2. **A provider whose declarations are inconsistent or too weak is refused, not downgraded** (`assessProvider`): outbound is unavailable,
   the reasons are logged and counted.
3. **"Not found" is believed only after the settle window and within the lookup's retention.** Before that the send stays `PROCESSING`;
   the lease always covers the window (`leaseFor`) and a call is never started without it, so an expired lease implies a settled window.
   Idempotent providers retry with the same key; providers with neither promise leave the send `UNKNOWN`.
4. **Cancellation is never assumed.** The worker aborts its call (`AbortSignal`) but the policy does not depend on the adapter honouring it.
5. **Manual resolution follows the provider's timing**: the 10-minute constant is a floor, `resolveGuardMs` is the real requirement, and a
   "no record" older than the lookup's retention is inconclusive.
6. **Outbound limits are counted from the durable ledger** (`outbound_emails`) inside the reply's transaction under a per-organization
   advisory lock: exact under concurrency, no bypass through idempotency keys, fail closed, no new infrastructure, no in-memory counters.

## Alternatives considered

- Redis counters (the existing rate limiter): rejected as the authority because it falls back to per-process memory when Redis fails, which would fail OPEN and reset on restart.
  It remains right for cheap request-level throttling elsewhere.
- A separate quota/counter table: rejected; the ledger already has one row per accepted reply, and a second source of truth could drift.
- Waiting inline for the settle window in the worker: rejected; holding a worker for minutes per send does not scale. Leaving the row `PROCESSING` until its lease expires reuses the existing recovery path.

## Consequences

- With a real provider, an ambiguous send waits (minutes) before it is retried, and ends `UNKNOWN` more often when the provider cannot be asked. That is intended.
- A real adapter cannot be enabled in production without a committed evidence file.
- Per-plan quotas, calendar-day quotas and a platform-operator role are not part of this decision.
