# 016 - Durable domain events (transactional outbox)

Status: accepted for the shared message/conversation path and inbound email; remaining emit sites listed below

## Context

Domain events (`message.created`, `conversation.created`, `conversation.status_changed`, `customer.created`, ...)
drive realtime hints and automations. They were emitted AFTER the transaction that caused them committed
(`emitDomainEvent`). If the process died, or the queue/Redis was unavailable, between the commit and the
emission, the change existed and its events were lost forever: no realtime hint, no automation. For inbound
email this is worse than for a click in the UI, because the provider's retry cannot repair it: the retry sees a
duplicate and (correctly) does nothing. Phase 9.2's audit recorded this as recommendation H2.

## Decision

A **transactional outbox**: `domain_event_outbox`.

1. In the transaction of a change, `recordDomainEvent(tx, ...)` inserts the event. It commits with the change
   or not at all. The row's `id` IS the event id.
2. After the commit, `publishRecordedEvents(events)` publishes (realtime hint, automation dispatch) and marks
   them published. It never throws.
3. Anything not published (crash, queue down) is re-published by `reconcileOutbox()` with the **same event id**.
   The reconciler runs in the existing worker process (see below).

Why a retry cannot run an automation twice:

- The engine creates one execution per `(automation, event id)` under a unique key; a second dispatch of the
  same event creates nothing.
- The one hole that unique key leaves is an execution that was recorded but never queued (a crash between the two
  statements). Previously a replay saw "duplicate" and skipped it, leaving a QUEUED run nobody would execute
  (confirmed with a failing test). On a **redelivery** the engine now re-queues such an execution. That is safe
  because the queue deduplicates by execution id and a worker takes ownership of a run with one atomic update.
- Realtime hints are idempotent (a client refetches).

Details that matter:

- **Leases, not locks.** A row carries `leaseUntil`. The request that recorded it owns it for 30 s; a reconciler
  claims a due row with a conditional update (`WHERE publishedAt IS NULL AND leaseUntil <= now`), so several
  workers never take the same row. Failures push the lease out with exponential backoff (30 s doubling, capped at
  1 h); nothing is ever dropped, and a stuck event raises an alert.
- **Automation loops stay impossible.** `causedByAutomation` is stored with the event, so a retried event that
  an automation's own action caused still never triggers automations.
- **No content duplication.** The outbox stores ids and enum values. `message.created.body` (used by automation
  conditions) is read back from `messages` when publishing.
- **Short audit trail.** Published rows are deleted after 7 days.
- **Clock honesty.** No CHECK compares application and database timestamps (a first draft did, and a test
  showed that clock skew would make a legitimate publish fail).

## Event inventory (what is durable today)

| Event                                        | Emitted by                                                                                                             | Publication |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| `message.created`                            | every message: staff, web chat, portal, AI reply, inbound email                                                        | **durable** |
| `conversation.created`                       | `createConversationCore` (staff, widget, portal) and inbound email                                                     | **durable** |
| `conversation.status_changed`                | a customer message reopening a conversation; staff status change (`updateConversation`)                                | **durable** |
| `conversation.priority_changed`              | staff priority change (`updateConversation`)                                                                           | **durable** |
| `conversation.assigned`                      | staff assign / claim (`assignConversation`)                                                                            | **durable** |
| `customer.created`                           | inbound email; the web chat visitor's placeholder customer (`ensureVisitorCustomer`)                                   | **durable** |
| `customer.created`                           | staff-created customers (`createCustomer`)                                                                             | best effort |
| `customer.updated`                           | staff update/archive (`customers.ts`); widget identity enrichment (`visitor.ts`); portal profile (`portal/profile.ts`) | best effort |
| `customer.tag_added`, `customer.tag_removed` | tag service (`customer-tags.ts`)                                                                                       | best effort |

Best effort means: emitted after the commit, never retried, lost if the process dies in that window. Realtime hints
self-heal (a client refetches); an automation trigger does not. Unassigning a conversation has no domain event at all (no
`conversation.unassigned` trigger exists), so there is nothing to lose.

**Follow-up completed (staff conversation changes and widget customers).** The three staff paths in `conversations.ts`
record their events inside the transaction that already wrapped the change, and `ensureVisitorCustomer` now creates the
placeholder customer, links the session and records `customer.created` in ONE transaction (previously: create, emit, then
link, which could leave an orphan customer, with an event already sent, when a concurrent request won the link). Preserved:
event ids are the outbox row ids; payloads, actor (`ctx.user.id`, or none for the visitor) and event order are unchanged
(status before priority); `causedByAutomation` is captured at record time so a retried event of an automation's own
change never triggers automations; every query keeps its organization scope. The staff paths also lock the conversation row
first (as the message path does), so concurrent changes apply in turn and each real change records exactly one event with the
right previous value. Tests: `tests/integration/domain-events-staff-widget.test.ts`.

**Remaining best-effort paths and why.** `customer.created/updated` from the customers service and the tag events are staff
CRUD that the user can see and redo; `customer.updated` from widget identity and portal profile only enriches a record
(each of those writes is a single statement outside a transaction, so making it durable means wrapping it first). They are
not business-critical for the inbound-email stage. Recommended order if they become important: staff customer create, then
the profile/identity updates, then tags, each with its own regression run.

## Scope and generalization

Implemented for everything that goes through `persistMessageInTransaction` and
`createConversationInTransaction`, i.e. **every channel** (staff, web chat visitor, portal, AI replies, email) for
`message.created`, `conversation.status_changed` and `conversation.created`, plus `customer.created` for customers
created by inbound email. These were chosen because they are the events a lost message hurts most and because
those two functions already run inside the caller's transaction, so no behavior had to move.

Not migrated: see the inventory above (remaining best-effort paths).

## Alternatives considered

- **Publish as a BullMQ job in the same request.** Moves the gap from "emit" to "enqueue", and Redis is not in the
  transaction. Rejected.
- **Postgres LISTEN/NOTIFY or logical decoding.** Correct but needs a long-lived connection/replication slot and
  infrastructure the project does not run. Rejected for now.
- **Do nothing and rely on the provider's retry.** Does not work: the retry is a duplicate.

## Operational contract

- **Ordering.** Events of one request are published in order; across requests, and on a redelivery, order is not
  guaranteed. Consumers must not depend on cross-event ordering (the automation engine and realtime hints do not).
- **Retry behavior.** First failure: retry after 30 s, doubling to a cap of 1 h, forever. An unknown event type or a poison
  event is retried at the cap and raises the `domain_event_outbox_retrying` alert at 8 attempts; it never blocks other events
  (each claim moves only its own lease, tested with a batch size of one). An operator resolves a poison event by hand.
- **Concurrent workers.** A claim is a conditional update on `(publishedAt IS NULL, leaseUntil <= now)`: exactly one worker wins
  a row, a crashed worker's rows come back when the 60 s lease expires, and a double publication (a slow worker plus a
  reclaim) is harmless because the engine deduplicates by event id.
- **Worker health.** The web tier exposes `GET /api/health/background` (separate from `/api/health`), computed from the
  worker heartbeat and the age of the oldest unpublished event; see [email-operations](../email-operations.md).

## Consequences

- One extra insert per event inside the existing transaction.
- A committed change can no longer lose its events; at worst they are late (alert thresholds in
  [email-operations](../email-operations.md)).
- Additive migration `domain_event_outbox`.
