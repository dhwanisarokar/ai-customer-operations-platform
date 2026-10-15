# Phase 9.2 readiness review

> **Historical report (Phase 9.2).** A point-in-time readiness review of the inbound email stage as it was then. Phases 9.3 to 9.7 changed the code afterwards; for current behavior see [email](email.md), [outbound](email-outbound.md) and [operations](email-operations.md).

Scope: the inbound email stage, its durable-event outbox and its operations. Companion documents:
[email](email.md), [audit](email-audit-9.2.md), [operations](email-operations.md), [adapter contract](email-adapter-contract.md),
ADR [015](decisions/015-email-channel-and-provider-adapter.md) and [016](decisions/016-durable-domain-events.md).
Everything was exercised against the fake provider and a real PostgreSQL/Redis. **No real provider, DNS or credentials were used,
so no provider-level security or behavior is verified.**

## Confirmed defects found in this pass (all fixed)

1. A spoofed-mail flood could use up an organization's hourly quota and lock legitimate customers out (unauthenticated held
   mail was counted). Unauthenticated mail no longer counts toward the quota; it stays bounded by its own held cap and the
   per-sender cap.
2. Unresolved held mail was never removed, and nothing can resolve it yet, so a full queue would turn legitimate mail away
   forever. Expiry added (30 days; floors below).
3. The replay-ledger retention was a fixed number unrelated to the provider. It is now derived from the adapter's declared
   freshness window and retry horizon, and the combination that would make the provider's own retries fail as stale is rejected.
4. A shutdown could cut a maintenance pass in half. Stop now waits for the pass (bounded).
5. A stopped worker was invisible. Added a heartbeat and a separate health endpoint (below).

## Decisions made

| Topic                         | Decision                                                                                                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable vs best-effort events | Inventory in ADR 016. Durable: every message, `conversation.created`, reopen status change, email-created customers. Best effort: staff status/priority/assignment, customer created/updated by staff or widget, tags. |
| Smallest follow-up            | DONE in the follow-up change: staff status/priority/assignment and the widget visitor's `customer.created` are now durable (ADR 016). The rest stays best effort, listed in the ADR.                                   |
| Worker health                 | `GET /api/health/background`, separate from `/api/health`; heartbeat row in `worker_heartbeats`; external monitor required; no new infrastructure.                                                                     |
| Org-cap exhaustion            | Drop and acknowledge; spoofed mail does not count; alerts make it visible. Holding instead of dropping rejected for now (it would need the review workflow).                                                           |
| Held sub-caps                 | 100 / 50 / 25 / 25 by reason within 200; saturation is a critical alert.                                                                                                                                               |
| Ledger retention              | 30 days default, never below 7 days nor below twice the provider's replay span.                                                                                                                                        |
| Held expiry                   | Unresolved held mail discarded at 30 days, floor 14 days and the same replay-span floor. Review UI deferred.                                                                                                           |
| Adapter contract              | Finalized in the adapter-contract document, with contract tests for replay keys and the replay policy.                                                                                                                 |

## Review notes (migrations, transactions, retries, concurrency)

- **Migrations since 9.1** (all additive, none applied to the real database): `email_inbound`, `email_inbound_hardening`,
  `domain_event_outbox`, `email_auth_detail`, `worker_heartbeat`. Each was applied to a fresh scratch database and to one with seeded data
  (counts unchanged), and `prisma migrate diff` is empty against the schema. One caveat for a large production database:
  `email_inbound` builds a unique index on `messages(id, conversationId, organizationId)`, which blocks writes to `messages`
  while it builds (Prisma migrations cannot use `CONCURRENTLY`); apply it in a quiet period.
- **Transaction boundaries.** One interactive transaction per organization per email holds a per-organization advisory lock;
  it contains the duplicate and cap checks, customer, conversation, message, email record and outbox rows. Events are published
  strictly after commit. Prisma's default interactive-transaction timeout (5 s) applies: a large burst for one organization
  queues on the lock and its tail may time out and be retried by the provider (safe, idempotent).
- **Outbox retries and concurrent workers.** Claims are conditional updates with a lease; poison events are skipped
  (tested with a batch size of one); a double publication is harmless because the engine deduplicates by event id and an execution
  that was recorded but never queued is re-queued on redelivery (mutation-checked).
- **Known limits, accepted:** cross-event ordering is not guaranteed on redelivery; a poison outbox event retries hourly
  forever and alerts at 8 attempts (an operator resolves it); counters are per instance (use the log pipeline or the gauges).

## Migration portability finding (fixed in this pass)

The hardening migration contained literal invisible characters (bidi overrides, line separators) in SQL strings instead of
Unicode escape sequences, so it failed to apply through a client using the Windows WIN1252 encoding. It is now pure ASCII (a guard
test checks every migration), it needs a UTF8 database and says so with an explicit error otherwise, and the whole chain was applied
with `prisma migrate deploy` to a fresh scratch UTF8 database with an empty drift afterwards. The real database is expected to be UTF8
(confirm before deploying: `SHOW server_encoding`).

## Flaky tests and environment limits

- The full suite passed in repeated complete runs after the final change. **One earlier run hung** (a vitest process that did
  not exit) while a test file had failing assertions; it was stopped and not reproduced in any later run, and its cause was not
  isolated (suspected: an open handle left by failing tests).
- A test that depends on timing (`email-inbound-audit`, the concurrent-reopen race) was made deterministic with a lock-holding
  transaction and mutation-checked; two tests use short sleeps (100-400 ms) to let asynchronous realtime hints arrive.
- The production build was run in a scratch copy with webpack, not Turbopack, because dev servers were running (they would be
  clobbered by a build in place). BullMQ prints an unrelated optional-dependency warning (`@valkey/valkey-glide`).
- Test databases are scratch PostgreSQL 18 and Redis 5 instances on localhost; behavior on the real Supabase instance is not exercised.

## Remaining production prerequisites (before email is enabled for real customers)

1. **A real adapter and provider account**: SES decision confirmed against operational cost; adapter written to the contract; the
   checklist in the adapter-contract document completed, including how SPF/DKIM domains are obtained.
2. **A domain and DNS access** for the platform email domain (MX, SPF, DKIM, DMARC); none exists today.
3. **Held-mail review workflow** (list, attach, release, discard, audit). Until it exists held mail is write-only; enabling email
   without it means spoofed-looking or archived-customer mail is silently expired after 30 days.
4. **A running worker in production** and an **external monitor** on `/api/health/background`; log-pipeline rules for the metrics and alert lines.
5. **Outbound delivery** (9.3): until then staff replies on email conversations are stored but not sent.
6. ~~Follow-up event durability for staff conversation changes and widget customers~~ done; the remaining best-effort paths are listed in ADR 016.
7. **Applying the migrations** to the real database with `npx prisma migrate deploy`, in a quiet period (see the index note), after confirming the database is UTF8.
8. A decision on **per-organization settings for quotas** (currently constants) if tenants differ greatly in volume.
