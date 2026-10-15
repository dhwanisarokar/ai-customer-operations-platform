# 017 - Outbound email: a database outbox, conditional state transitions, and no blind resend

Status: accepted for the foundation (9.3A, fake provider only)

## Context

Sending a staff reply as an email crosses a boundary the platform cannot make transactional: the provider. The worker model is
at-least-once (queue jobs repeat, workers race and die), and the provider call has an outcome we sometimes cannot observe (a
timeout after the request left). A duplicate customer email and a silently lost one are both real harm, and "exactly once" is not
achievable across that boundary.

## Decision

1. **The database is the source of truth.** One `outbound_emails` row per logical email, created in the SAME transaction as the
   staff message. The queue carries only a wake-up (ids, no content); a lost or duplicated job is harmless, and the worker's
   reconciler recreates wake-ups for everything due. No new worker framework or infrastructure: it reuses the shared queue, the
   worker process, the maintenance loop, the heartbeat and the background health endpoint.
2. **Every state change is one conditional update** (expected status, and for in-flight work the expected attempt number as a
   fencing token). No read-then-write. A claim increments `attempts` and takes a lease BEFORE the provider is called.
3. **A provider result has four classes**: success, permanent failure, retryable failure, and **ambiguous**. Ambiguous (a lost
   response, a thrown adapter, a worker that died holding the claim) is resolved only when that cannot duplicate: an authoritative
   lookup by idempotency key, or a provider that is idempotent by that key. Otherwise the send stays `UNKNOWN` for an operator.
   It is never blindly resent, never recorded as sent without proof, never recorded as failed without proof.
4. **Providers declare what they promise** (`SendingCapabilities`, false by default). The policy depends on those declarations, so
   a real adapter cannot get the safe behaviour by accident: it must verify the claim first.
5. **Threading from recorded Message-IDs only**, scoped to the organization and conversation; our `Message-ID` is deterministic and fixed at
   creation so every attempt is identical; an `OUTBOUND` `email_messages` row makes the customer's reply thread correctly.
6. **Production safety**: the fake provider is refused by environment validation and again by the sender; no provider is chosen as a fallback.

## Alternatives considered

- **Send inline in the request / only a BullMQ job.** Loses the send when Redis or the process fails between commit and enqueue.
- **Retry ambiguous outcomes automatically.** Risks duplicate customer emails; rejected unless the provider proves it cannot duplicate.
- **Mark ambiguous outcomes failed (or sent).** Both would be false statements. `UNKNOWN` is honest.
- **Delayed BullMQ jobs for retries.** Moves the schedule into Redis (lost on flush) and the in-memory queue has no equivalent; the
  database `nextAttemptAt` plus the minute pass is simpler and survives restarts, at the cost of up to one interval of latency.
- **A separate dispatcher service.** Unjustified operational cost.

## Amendment (Phase 9.3B): the inbox

- **A dedicated email-reply endpoint, not a flag on the plain one.** `POST .../email-reply` accepts only `{body, clientMessageId}` (strict). The plain `POST .../messages` now REFUSES a customer-facing staff reply on an `EMAIL` conversation: a reply that was stored but never sent would look sent to the team. Internal notes, logged customer messages and other channels are untouched.
- **Request idempotency reuses the existing `clientMessageId` uniqueness** on messages: the browser mints the key once per logical reply and the outbox item reuses it on retry; a repeat returns the original (200) and queues nothing; a key reused with other content, by another user, or for a non-email message is a 409.
- **Delivery state is persisted server state** attached to the message list (`emailDelivery`, a deliberately small DTO), never client state. `accepted` is provider acceptance, `unknown` is its own uncertain state. Freshness uses the existing realtime hint (`conversation.updated`) plus TanStack's `refetchInterval` only while something is in flight: no new polling framework.

## Amendment (Phase 9.4): resolving UNKNOWN safely

- **No role can decide an outcome it cannot prove.** The only exits from UNKNOWN take typed evidence: the provider's own lookup found it, the provider's authoritative lookup has no record, or an operator with production access attested "not sent". There is no exit to SENT on someone's say-so, and nothing resends. `confirmUnknown`, which allowed it, was removed.
- **No platform-operator role exists, so none is simulated.** The organization view and the provider re-check use `manage_email` for the caller's own organization; the operator attestation is a server-side CLI, not an HTTP endpoint. A platform-wide view and a web attestation need a real platform-operator model (a later decision).
- **Every resolution is audited atomically** in an append-only table whose CHECKs list the only permitted transitions; resolutions are conditional on UNKNOWN and never recent (a hung provider call can still finish), and stale workers stay fenced.
- **Receipts and bounces are specified, not built**: a monotone outcome model kept apart from SENT (acceptance), with duplicate and ordering safety proved over every ordering, tenant-safe correlation, and a deferred minimum schema.

## Consequences

- At-least-once worker execution with a visible, bounded residual risk (documented in [email-outbound](../email-outbound.md)).
- Retries and recovery depend on the worker's maintenance pass; its health is already monitored.
- `UNKNOWN` requires a human until delivery receipts and a review UI exist.
- Additive migrations: `outbound_email` (9.3A) and `outbound_email_audit` (9.4).
