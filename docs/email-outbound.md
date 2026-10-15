# Outbound email delivery foundation (Phase 9.3A)

A durable, tenant-safe way to send a staff reply as an email, tested with the fake provider. Phase 9.3A built the delivery
foundation; **Phase 9.3B wires it to the staff inbox** (see [Inbox integration](#inbox-integration-phase-93b)). **No real
provider, no delivery receipts, no operations dashboard.** Nothing here claims exactly-once delivery to a
customer; the exact guarantees and their limits are in [Duplicate-send safeguards](#duplicate-send-safeguards-and-their-limits).
Companions: [email](email.md), [adapter contract](email-adapter-contract.md), [operations](email-operations.md),
ADR [016](decisions/016-durable-domain-events.md) and [017](decisions/017-outbound-email-outbox.md).

## Architecture

```
createOutboundReply (service; called by POST /api/conversations/:id/email-reply)           one transaction
   persistMessageInTransaction  +  recordOutboundEmail  ------->  messages, outbound_emails (PENDING), email_messages (OUTBOUND)
        | after commit: publish message events, queue a wake-up (best effort)
        v
queue job {kind:"email-send", sendId, organizationId}  (ids only; a hint, not the truth)
        v
processEmailSendJob: read row -> claim (atomic) -> call provider (bounded) -> record outcome (fenced)
        ^
reconcileOutboundEmail (worker maintenance pass, every minute):
   resolve attempts whose worker died  +  re-queue every DUE send (lost / never-queued jobs, retries whose time came)
```

The database row is the only source of truth. The queue is a wake-up signal; losing it loses nothing (the reconciler recreates
it). No new infrastructure or worker framework: it reuses the shared BullMQ queue and `npm run worker`, the maintenance loop,
the heartbeat and `/api/health/background`, and the existing provider interface and `FakeEmailProvider`.

| Piece                                                                    | File                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Table, enum, constraints                                                 | `prisma/schema.prisma`, migration `20261019000000_outbound_email`       |
| State machine, retry policy, decisions (pure)                            | `src/server/email/outbound-state.ts`                                    |
| Service: record, deliver, recover, reconcile                             | `src/server/email/outbound.ts`                                          |
| Conditional-update repository                                            | `src/server/repositories/outbound-email.ts`                             |
| Provider contract (`SendResult`, `SendingCapabilities`, `findSendByKey`) | `src/server/email/provider.ts`, fake in `fake-provider.ts`              |
| Queue job kind and router                                                | `src/server/automation/queue/types.ts`, `src/server/jobs.ts`            |
| Alerts, gauges, health                                                   | `src/server/maintenance.ts`, `src/server/services/background-health.ts` |

## Data model (`outbound_emails`)

One row per logical outbound email. `id` is the **send id and the provider idempotency key**.

| Column(s)                                                                       | Purpose                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `organizationId`, `conversationId`, `messageId`                                 | tenant-scoped references; composite foreign keys `(conversationId, organizationId)` and `(messageId, conversationId, organizationId)`; `messageId` is unique (one send per message)         |
| `emailSettingsId`                                                               | the organization's settings row the sender came from; composite FK `(emailSettingsId, organizationId)`, so a send can only name its own organization's settings                             |
| `fromAddress`, `fromName`, `toAddress`, `subject`                               | snapshots taken when the reply is created: a later settings change cannot alter an email already in flight. The recipient comes from the customer record on the server, never from a client |
| `rfcMessageId`, `inReplyTo`, `references`                                       | threading, fixed at creation so every attempt sends identical headers; unique `(organizationId, rfcMessageId)`                                                                              |
| `status`, `attempts`, `retries`, `nextAttemptAt`, `leaseUntil`, `lastAttemptAt` | the state machine, retry time and the claim lease                                                                                                                                           |
| `providerMessageId`, `lastErrorCode`, `finalReason`, `sentAt`, `failedAt`       | outcome; `lastErrorCode`/`finalReason` are short machine codes, never provider text                                                                                                         |

Not stored: the message body (read from `messages` when sending), any credential or provider secret. CHECK constraints keep a row
from claiming what it cannot back up (SENT needs a provider id and time, FAILED a time and a reason, PROCESSING a lease and an
attempt; waiting states have no lease), plus address/header hygiene (lower-case addresses, no CR/LF in subject or name, Message-ID shape,
bounded lists, coded errors). The allowed TRANSITIONS cannot be a CHECK (it cannot see the previous row), so they are enforced by
conditional updates and tested.

## States and transitions

| From                     | To              | When                                                                                                          |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------- |
| PENDING, RETRY_SCHEDULED | PROCESSING      | an atomic claim: `attempts + 1`, a lease, only when due                                                       |
| PROCESSING               | SENT            | the provider accepted (or an authoritative lookup proves it)                                                  |
| PROCESSING               | RETRY_SCHEDULED | a retryable failure, or an ambiguous outcome that is safe to retry; `nextAttemptAt` = now + backoff           |
| PROCESSING               | FAILED          | a permanent failure, retries exhausted, or a send-time check failed (`sender_unavailable`, `message_missing`) |
| PROCESSING               | UNKNOWN         | an ambiguous outcome with no safe way to find out (see below)                                                 |
| PROCESSING               | PROCESSING      | takeover of an expired lease (`attempts + 1`, new lease)                                                      |
| UNKNOWN                  | SENT, FAILED    | confirmed later (a receipt, an operator). Never an automatic resend                                           |

SENT and FAILED are final. `canTransition` and the table are tested exhaustively.

## Retry policy

Six attempts. The delay before attempt _n+1_ is `30 s * 2^(n-1)` capped at 1 h, with +-20% jitter (injectable for tests).
Retryable failures retry; permanent ones never do; running out of attempts is an explicit `FAILED / retries_exhausted`.
Retries live in the database (`nextAttemptAt`), so they survive restarts; they are woken by the worker's minute pass, so retry
latency is the delay plus up to one maintenance interval.

## Ambiguous outcomes (the heart of it)

An attempt is **ambiguous** when the provider may have accepted the email but we do not know: a timeout or lost response (the
call is bounded at 45 s), an adapter that throws, or a worker that died after claiming (its lease expired). Abandoning a request does
**not** cancel it: the provider may still accept it later. The provider declares what it can promise (`SendingCapabilities`, with
`readiness`: declared is not verified; see [email-provider-readiness](email-provider-readiness.md)) and the platform derives one of three
modes (`reconciliationMode`, `src/server/email/outbound-state.ts`):

1. An authoritative **lookup by key finds** the send -> record **SENT** (proof), in every mode.
2. **`idempotent`** (declared, key memory at least twice the retry horizon): retry with the **same key**; a duplicate, even a late one, is refused by the provider. Out of attempts with the outcome still unconfirmed -> `UNKNOWN`, never `FAILED`.
3. **`lookup`** (the lookup states its consistency, its retention and how late a request may still land): **not found** is believed only when (a) the **settle window** has passed since the request was sent (`lateAcceptanceCeilingMs + lookupSettleMs`) and (b) the lookup still remembers (`lookupRetentionMs`). Before the window the send **stays `PROCESSING`** (nothing is resent) and recovery asks again once its lease expired; after the retention it becomes `UNKNOWN`. Then, and only then: `RETRY_SCHEDULED` (or `FAILED` when out of attempts: nothing was accepted, so this is truthful).
4. **`none`** (nothing declared, or a declaration that is missing or too weak): **UNKNOWN**, kept for an operator. **Never a blind resend, never "sent" without proof, never "failed" without proof.**

Two mechanisms make "the lease expired" mean "the window has passed": `leaseFor(provider)` is at least the settle window plus the call and
lookup timeouts, and `attemptDelivery` **does not start** a call when less than the settle window of the lease remains (since 9.7 it first extends its own lease, fenced by the attempt number, and calls only if that succeeded; see below). A takeover does not touch `lastAttemptAt` (the claim time), which is the upper bound
of the request's age used for the retention check. The worker passes an `AbortSignal` to `sendEmail` when it gives up; whether the
adapter honours it never matters for correctness.

Tests: `outbound-state.test.ts` (an exhaustive sweep of capabilities x lookup answers x timing: nothing is retried or failed without an idempotent provider or a settled, retained,
authoritative not-found), `tests/integration/email-outbound-reconciliation.test.ts` (late acceptance, a lagging lookup, retention, takeover, stale attempts, the lease guard, database
failure after acceptance), `provider-policy.test.ts`.

## Crash and restart recovery

| Where the worker died                                                  | State left behind         | What recovers it                                                                                                                                 |
| ---------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| after the row was recorded, before a job was queued (or Redis lost it) | PENDING                   | the reconciler re-queues every due send                                                                                                          |
| after the claim, before the provider was called                        | PROCESSING, lease running | when the lease expires the reconciler takes it over and resolves it as ambiguous: lookup says not found -> retry; or UNKNOWN when it cannot tell |
| after the provider accepted, before the database was updated           | PROCESSING                | the same path: the lookup finds the key -> SENT (no second email); an idempotent provider dedupes a same-key retry; otherwise UNKNOWN            |
| a database error while recording the outcome                           | PROCESSING (never SENT)   | the same lease path                                                                                                                              |
| a retry was scheduled, then the process restarted                      | RETRY_SCHEDULED           | the reconciler wakes it when `nextAttemptAt` arrives                                                                                             |

A takeover increments `attempts`; the attempt number is the **fencing token** on every outcome update, so a worker that wakes up
after being replaced cannot overwrite the newer attempt (tested with a newer attempt genuinely in flight, and mutation-checked).

## Duplicate-send safeguards and their limits

The worker model is **at-least-once**: a queue job can run twice, two workers can race, a worker can die anywhere. What the
design guarantees, and what it does not:

- **One logical send = one row** (unique per message), and the send id is the provider idempotency key on every attempt.
- **Atomic claim before the provider call**: concurrent workers (and duplicate jobs) cannot both call the provider for the same
  attempt (10 concurrent claims -> exactly one winner; 8 duplicate jobs -> one provider call).
- **Fenced finalization** and **leases** keep a stale or hung worker from corrupting state.
- **Stable headers**: every attempt sends the same `Message-ID`, so even a duplicate that reached a customer is recognisable as the same message.
- **No blind resend after an ambiguous outcome** (above).
- **Limits.** (a) With a provider that is neither idempotent nor queryable, an ambiguous outcome may mean the customer _did_
  receive the email while we record `UNKNOWN`; we choose a visible unknown over a possible duplicate. (b) Idempotency is only as
  strong as the provider's key memory (how long keys are remembered must be verified per provider). (c) A hung provider call
  that completes after a takeover cannot be cancelled; the fence stops it corrupting state, the provider's idempotency (or the
  lookup) is what prevents a second delivery. (d) The fake provider models these behaviours; it validates nothing about real
  deliverability. **Exactly-once delivery to the customer is not claimed and not achievable in general.**

## Threading

`In-Reply-To` is the customer's latest recorded message (or our latest email if none); `References` is the chain of recorded
Message-IDs oldest to newest, ending with it, at most 20. They come only from this conversation's `email_messages` inside the
organization, never from the subject; a conversation with no recorded ids starts a fresh thread (`In-Reply-To` empty). The
outbound `Message-ID` is `<sendId@platform-domain>`. An `OUTBOUND` row is written to `email_messages` in the same transaction,
so the existing inbound threading finds the conversation when the customer replies to it (tested, including a different subject).
The row's `providerMessageId` is filled once the provider accepts. The subject is `Re: <conversation subject>` once, header-safe.

## Security and tenant isolation

- Every repository call is keyed by `(id, organizationId)`; a job carries the organization and a send of another organization is "not found". The reconciler works across organizations but only handles ids.
- Recipient from the customer record, sender from the organization's verified settings, threading from its own conversation: nothing from a client. `createOutboundReply` requires `send_messages` and runs in the caller's organization.
- At send time the send is re-checked: email still enabled and the snapshot address is still the organization's verified one (`sender_unavailable`), the message still a customer-facing staff message (`message_missing`). Otherwise a final failure, no provider call.
- The fake provider is refused in production twice (env validation, and the sender refuses it even if injected); no provider is chosen as a fallback.
- Logs, metrics and job payloads hold ids and codes only; provider errors are reduced to `^[a-z0-9_]{1,64}$` before they are stored or logged.
- No API or UI exposes delivery state in this phase, so there is nothing new to authorize.

## Worker, health and metrics

Queue jobs: `{kind:"email-send", executionId:"email-send-<id>-<attempts>", organizationId, sendId}` (no body, no address; BullMQ ids may
not contain `:`; the attempt number keeps a later retry from being swallowed by deduplication of an earlier completed job).
Each maintenance pass runs `reconcileOutboundEmail`. Metrics: `email_outbound_total{result}` (sent, retry_scheduled, failed, unknown,
ambiguous, recovered, skipped{reason}, stale, finalize_failed, wakeup_failed) and gauges `email_outbound_due`,
`email_outbound_oldest_due_age_seconds`, `email_outbound_unknown`. Alerts: due-but-unsent email at 10 min (warn) / 60 min (critical);
any UNKNOWN (warn, "needs an operator"). `/api/health/background` gains `checks.outbound` (`ok|delayed|stuck`, from the same age;
work waiting by design, such as a scheduled retry, does not count) and `details.unknownEmails` (informational).

**Operating an UNKNOWN send:** see [Operational safety (Phase 9.4)](#operational-safety-phase-94). The earlier advice to call a
repository function by hand was withdrawn: that function had no authorization, no audit and accepted any provider id.

## Known gaps and production risks

- No delivery receipts or bounce handling yet (inbound `delivery` notifications are still acknowledged and ignored); `SENT` means "the provider accepted it", not "delivered", and the inbox says so.
- No real adapter: `SendingCapabilities` and `findSendByKey` are modelled by the fake only; each real provider must verify them (see the adapter-contract checklist).
- Retry latency includes up to one maintenance interval; the in-process development queue has no worker, so a Redis-less development run sends immediately but never retries or recovers (there is no maintenance loop there).
- `UNKNOWN` needs an operator; there is no UI or notification beyond the alert.
- Attachments are not sent (plain text only), CC/BCC are not supported.
- A worker killed while holding a claim leaves its send in `PROCESSING` until the lease (2 minutes) expires.

## Inbox integration (Phase 9.3B)

### The send flow

```
Composer ("Reply" mode, EMAIL conversation)        one idempotency key (UUID) per logical reply, reused on retry
   -> POST /api/conversations/:id/email-reply      { body, clientMessageId }   (strict: nothing else is accepted)
        requireOrganizationContext -> send_messages -> createOutboundReply
        -> conversation must exist in THIS organization (else 404)
        -> repeat of an earlier key? -> return the original (200), create and queue nothing
        -> ONE transaction: staff message + outbound_emails row (PENDING) + OUTBOUND thread row
           (recipient from the customer record, sender from the verified settings, threading from recorded ids)
        -> after commit: message events (durable outbox), wake-up queued (best effort)
   <- 201 { message, delivery:{state:"queued"}, duplicate:false }       (the provider is never called here)
worker (9.3A): claim -> provider -> record outcome        realtime hint "conversation.updated" -> staff clients refetch
```

The route calls no provider and does no retrying; the outbox from 9.3A is authoritative, queue jobs stay wake-ups, `UNKNOWN` is never resent.

### Authorization and recipient rules

- Authentication and organization come from the session (`requireOrganizationContext`); the permission is `send_messages` (every member), as for any reply.
- The request schema is strict: **only `body` and `clientMessageId`**. A recipient, sender address or name, organization id, customer id, subject, Message-ID, `In-Reply-To`, `References`, CC, message type or author is rejected with 400 and creates nothing.
- The recipient is the conversation's customer address, read from the persisted record; the sender is the organization's own verified, enabled settings; the conversation is resolved inside the caller's organization, so another organization's conversation is simply "not found". Composite foreign keys (9.3A) enforce the same relations in the database.
- Eligibility, enforced atomically with the message (a refusal rolls the message back too, 409): the conversation is on the `EMAIL` channel, the customer is not archived and has an address, email is configured on the platform, and the organization's settings exist, are enabled and verified. A resolved conversation must be reopened first, like any reply.
- **The plain message path no longer accepts a customer-facing staff reply on an `EMAIL` conversation** (409 "send replies by email"). Before, such a message would be stored and never sent, which looks like a reply the customer never receives. Internal notes, logged customer messages and every other channel are unchanged.

### Request idempotency

`clientMessageId` is generated by the browser once per logical reply (in the composer) and stored in the outbox item's input, so Retry re-sends the very same key. The messages table is unique on `(conversation, clientMessageId)` and there is one send per message, so two requests with the same key can never create two messages or two sends:

- a repeat returns the original message and its **current** delivery state, status **200** with `duplicate: true`, and queues nothing (the reconciler covers a lost wake-up);
- concurrent identical requests (a double click, two tabs): exactly one is created, the others get the winner;
- the same key with different text, from another staff member, or already used by a message that is not an email reply: **409**, never someone else's record;
- the key is scoped to the conversation.

### How delivery state reaches the inbox

`GET .../messages` attaches `emailDelivery` to the messages of an **email** conversation that have an outbound send (one organization- and conversation-scoped query; other channels get no such field). It is derived from the persisted row:

| `state`    | Persisted status | Shown to staff as                                                                                                  |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `queued`   | PENDING          | Queued to send by email                                                                                            |
| `sending`  | PROCESSING       | Sending by email...                                                                                                |
| `accepted` | SENT             | Accepted by the mail provider, delivery to the customer's inbox is **not confirmed**                               |
| `retrying` | RETRY_SCHEDULED  | Temporary problem, retrying (next attempt time)                                                                    |
| `failed`   | FAILED           | Email not sent, with a coarse reason (refused / retries used up / email switched off or changed / message missing) |
| `unknown`  | UNKNOWN          | Outcome unknown: it may or may not have been delivered; check before sending it again. Neither success nor failure |

Exposed fields: `state, retryAt, acceptedAt, failedAt, failure` (the internal attempt counter is deliberately not exposed). Never exposed: the provider's message id, raw error codes, addresses, Message-IDs, leases. A message accepted by the provider whose database update failed shows as `sending` until recovery proves it (it is never shown as accepted without proof).
Authorization is the existing one for reading a conversation (`view_conversations`, own organization). The timeline renders the line only for staff-authored customer-facing messages (never for notes, customer or AI messages), and it is separate from the browser-side "sending/sent" tick of the HTTP request.

Freshness: every outcome the worker records publishes a content-free `conversation.updated` realtime hint to the organization's staff stream, and the clients' existing invalidation refetches the authorized list. As a fallback when the stream is down, the message query re-reads every 10 seconds, **only while a message is queued, sending or retrying** (TanStack's built-in `refetchInterval`; it stops when everything is settled and never runs for other channels).

### Known gaps (9.3B)

- Provider acceptance is shown, delivery is not: there are no delivery receipts or bounce handling yet, so a bounced email still shows "accepted".
- `UNKNOWN` is displayed with a warning. Since 9.4 admins have an operational view and an evidence-based re-check, and an operator can attest "not sent"; there is still no resend and no way to mark an unknown email sent (see below).
- Plain text only; no attachments, CC or BCC; the subject is `Re: <conversation subject>` and cannot be edited.
- Without a running worker an email stays "queued" (truthfully); the background health endpoint and alerts report the stalled worker.
- A resend after a failed email is a new reply (a new key), written by the staff member.

## Operational safety (Phase 9.4)

### What the review found (verified in code, not assumed from the docs)

- `confirmUnknown` (9.3A) was a repository function only: no route, service or script called it, and it had no authorization, no audit and accepted an arbitrary provider id for `SENT`. The operations advice to use it was a documentation-level hazard. It is replaced by `resolveUnknown`, which needs typed EVIDENCE (see below) and is called only by the audited service functions (a test scans the code to prove it).
- There is **no platform-operator role**: the roles are OWNER, ADMIN and MEMBER, all scoped to one organization. `manage_email` (ADMIN, OWNER) is the closest existing permission. So nothing here is platform-wide, and no organization admin is treated as a platform admin.
- A monitoring defect: the "oldest due" age ordered by `nextAttemptAt` but measured an in-flight send from its lease expiry, so an old crashed attempt with a recent lease expiry hid a send that had been waiting longer, and the alert and health age under-reported. Fixed (the oldest of each kind is read separately); a regression test fails against the old logic.
- What is safe today: reading the persisted state; waiting; the worker's own recovery (leases, fenced attempts); the system asking a provider that declares an authoritative lookup. What needs stronger evidence: anything that decides an UNKNOWN outcome. What is not implemented: delivery receipts, bounces, resend.

### The attention view

`GET /api/email-outbound/attention` (`manage_email`, the caller's organization only; page size capped at 50; optional `category`) and a small "Email delivery" card on the email settings page. It lists only sends that need attention, from persisted state, oldest first, with a per-category summary:

| Category         | Meaning                                                      | Normal states it is NOT                                                     |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `queued_overdue` | PENDING and due for more than 10 minutes                     | queued (not yet due, or due under 10 minutes ago)                           |
| `retry_overdue`  | RETRY_SCHEDULED and its time passed more than 10 minutes ago | a retry waiting for its scheduled time                                      |
| `lease_expired`  | PROCESSING whose lease expired more than 2 minutes ago       | in flight with a valid lease, or a lease the reconciler is about to resolve |
| `unknown`        | UNKNOWN                                                      |                                                                             |
| `failed`         | FAILED in the last 30 days                                   |                                                                             |

Each item shows: send id, conversation id, message id, category, the coarse state, since when, the coarse failure reason, the recipient **masked** (`e***@customer.test`) and `canRecheck`. Never exposed: bodies, subjects, full addresses, Message-IDs, provider ids, raw error codes or provider responses, lease times, credentials. Nothing appears for another organization.

### Resolving an UNKNOWN send: what is allowed

An UNKNOWN send is never resent by anything. It can leave UNKNOWN only through `resolveUnknown`, one conditional update (`status = UNKNOWN`) with typed evidence, written in the SAME transaction as an append-only audit row (`outbound_email_audits`; the database also restricts which transitions an audit row may describe):

| Path                                                                                | Who                                                      | Evidence                                                                                                                                             | Result                                                                                                                                                                           |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Re-check with the provider** (`POST /api/email-outbound/:id/recheck`, no body)    | an admin or owner of the organization, for its own sends | the PROVIDER's answer to an authoritative lookup by idempotency key; the caller cannot choose the outcome                                            | found -> `SENT` with the provider's own message id (acceptance, not delivery); no record -> `FAILED provider_has_no_record` (not sent); cannot answer -> stays UNKNOWN (audited) |
| **Operator attestation** (`npm run email:resolve-unknown`, not reachable over HTTP) | a person with production access to the server            | their written statement that they checked with the provider and it was NOT sent; identity and a reason of 10-500 characters are required and audited | `FAILED operator_confirmed_not_sent` only                                                                                                                                        |

Guarantees: both paths refuse while the last attempt's claim is younger than `resolveGuardMs` (the 10-minute floor, or the claim's lease plus the provider's settle window when that is longer: a hung provider call can still complete and a lookup can lag); a re-check also treats "no record" as **inconclusive** (nothing changes, audited as unavailable) when the claim is older than the provider's `lookupRetentionMs`; both are conditional on UNKNOWN, so a resolved send cannot be resolved again and a stale worker (which only finalizes PROCESSING attempts, fenced by the attempt number) cannot overwrite a resolved state; neither resends; **there is no path to mark an UNKNOWN send as sent on someone's say-so** (the operator path cannot produce SENT, the audit table forbids it, and the re-check takes the provider id only from the provider).

Remaining limitations (stated, not hidden): with a real provider that cannot be asked (no trusted lookup: `lookupByKey` false or its consistency, retention or late-acceptance bound undeclared, the default until verified) an UNKNOWN send can only be closed by an operator attesting "not sent"; if it WAS delivered it stays UNKNOWN until delivery receipts exist, and the inbox keeps showing "outcome unknown". A "not found" answer is only as authoritative as the adapter's declaration. The operator attestation is accountable but not verified by the system. A platform-wide operations view and a web UI for operator attestation need a platform-operator authorization model that does not exist; they are deliberately not faked with organization roles.

### Delivery receipts and bounces: the contract (not implemented)

`src/server/email/delivery-events.ts` fixes the rules as pure, tested functions; there is no webhook, no persistence and no state change yet, and inbound `delivery` notifications are still acknowledged and ignored.

- **Two facts, never merged.** `outbound_emails.status = SENT` is provider ACCEPTANCE. A delivery OUTCOME comes only from receipts: `none < accepted < delivered < negative`. Only `delivered` (or a complaint, which proves it) is delivery evidence, and only as authoritative as the provider's own definition. The fake provider verifies nothing about delivery.
- **Receipt shape** (strict, normalized by an adapter after verifying the provider's webhook): `eventId` (namespaced, stable across retries; the idempotency/replay key), `providerMessageId`, optional `sendId`, `type` (accepted, delivered, bounced = permanent only, rejected, complained), `occurredAt`, a coded `code`. There is no organization field, no recipient, no raw provider text; temporary deferrals are not events.
- **Duplicates and ordering.** The fold is idempotent, commutative and monotone (proved for every ordering of every combination): a duplicate changes nothing, a late event cannot weaken newer evidence, and arrival time and the provider's timestamp are deliberately not used to order. A bounce that arrives AFTER a delivery receipt wins (asynchronous bounces are real) and a late "delivered" cannot undo a bounce; `bounced` beats `rejected` by a fixed rule, not by who arrived first.
- **Replay.** The event id must be recorded in a unique ledger BEFORE applying, in the same transaction as the outcome update (the same pattern as the inbound replay ledger).
- **Tenant-safe correlation.** A receipt is matched by `providerMessageId` (which must be unique in the store) and, if echoed, our send id must agree; exactly one send must match. Zero, several or a mismatch quarantines the event (counted, never applied). The organization used is the matched send's, never a payload's.
- **Minimum schema when it is built (deferred, not essential now):** `outbound_emails.deliveryOutcome` (enum), `deliveryOutcomeAt`, `complainedAt`, a unique partial index on `providerMessageId`, and an `outbound_email_events` ledger (`eventId` unique, send id, type, received time). The existing status enum is left alone on purpose: SENT keeps meaning "accepted".

## Critical safety fixes (Phase 9.6)

Found by the 9.5 audit, fixed before any real provider can be enabled:

- **Ambiguous-send retry** (above): an immediate "not found" is no longer proof; a settle window, a retention bound, a lease that covers it and a call that is never started without it. Previously the worker scheduled a resend about 30 s after a timeout when an immediate lookup said "not found", which duplicates the email with any provider whose lookup lags or whose request can still land.
- **Capability policy** (`provider-policy.ts`, [email-provider-readiness](email-provider-readiness.md)): inconsistent or weak declarations are refused, never downgraded; production needs `verified` with evidence.
- **Abuse limits** (`outbound-limits.ts`): per organization (minute, day), per staff account (minute) and per recipient (hour), counted from `outbound_emails` itself inside the reply's transaction under a per-organization advisory lock. Exact under concurrency, no bypass by repeating or rotating an idempotency key (a repeat is answered before the check and creates nothing; a new key is a new email and is counted; a delivery retry reuses its row), fail closed (the control IS the database write; there is no in-memory counter), a refusal records and queues nothing. The client gets a generic 429 (`rate_limited`, `Retry-After`) with no tenant, recipient, count or limit. Monitoring: `email_outbound_rejected_total{reason}` (`org_day`, `org_minute`, `user_minute`, `recipient_hour`) and a log line with the organization id only. Configuration: `EMAIL_OUTBOUND_ORG_PER_MINUTE` (default 30, ceiling 600), `EMAIL_OUTBOUND_ORG_PER_DAY` (1000 / 100000), `EMAIL_OUTBOUND_USER_PER_MINUTE` (20 / 120), `EMAIL_OUTBOUND_RECIPIENT_PER_HOUR` (10 / 100); values above the ceiling or below 1 fail startup validation. Migration `20261021000000_outbound_email_limits_index` (additive: one index on `outbound_emails(organizationId, createdAt)`).

Known limits of the controls: they bound what staff can cause, not what the provider does; the quota is per organization and the same for every organization (no per-plan override); the daily window is rolling, not calendar based; replies that are refused are not queued for later.

## Outbound reliability (Phase 9.7)

### Four numbers that were being conflated

| Concept                             | Where                                          | Moves when                                                                                                                                                                                                                          |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ownership counter** (fence)       | `outbound_emails.attempts`                     | EVERY claim and EVERY takeover (`claim`, `takeOverExpired`). It only fences stale workers; it is bounded by a CHECK (0 to 50)                                                                                                       |
| **Retry budget** (logical attempt)  | `outbound_emails.retries` (new in 9.7)         | only when a retry is scheduled after an attempt that called (or may have called) the provider. The next decision is attempt `retries + 1`                                                                                           |
| **Recovery / reconciliation check** | `recoverExpired`                               | never moves the budget by itself. A check that finds the settle window open does not even take the send over again: it moves the lease to the end of the window (`extendLease`), so there is one more check then, not one per lease |
| **Provider send invocation**        | the fake's `sendCalls`; `email_outbound_total` | each real `sendEmail` call. Not stored: the budget (which includes attempts lost with a dead worker) is what bounds them                                                                                                            |

Before 9.7 the retry budget and the backoff used the ownership counter, so every takeover (and every repeated recovery check while a settle window was open) spent budget
without any send, and a crashed attempt cost two units. With a short budget a send could be declared `FAILED retries_exhausted` (or `UNKNOWN`) having tried the provider fewer
times than the policy allows, and repeated checks could approach the CHECK bound of 50. Now: `attemptDelivery` and `recoverExpired` decide with `retries + 1`;
`scheduleRetry` increments `retries` unless the attempt made no request (`noCall`: the final lease check failed); `attempts` keeps all its fencing guarantees untouched.
Migration `20261022000000_outbound_email_retry_budget` adds `retries` (default 0, CHECK 0 to 50; existing rows get a conservative value).

### The lease guard, completed

A claim whose lease would leave less than the provider's settle window before the call **extends its own lease** first (`extendLease`: one conditional update fenced by the attempt
number; it never shortens a lease and changes nothing else). If recovery already took the send over the extension is refused and **no call is made**. A final check that runs in the
same synchronous step as the call (no await between them) then compares the clock with the lease this worker holds; if that fails (the clock jumped) nothing is sent and a retry is
scheduled without spending budget. **What no software can remove**: a process frozen by the operating system between that last check and the actual request. With an idempotent
provider the late request is refused by the provider; with a lookup-only provider it is covered only by the declared late-acceptance ceiling plus the 30-second lease margin, so a
long freeze can still deliver a second copy. That residual is asserted explicitly in `email-outbound-reliability.test.ts`, not hidden.

### Queue wake-ups are hints, and BullMQ keeps finished job ids

Reproduced with the installed BullMQ and a disposable Redis (`tests/integration/email-bullmq-wakeups.test.ts`): `add` with an existing job id is a no-op, and completed jobs are retained for an
hour (`removeOnComplete: { age: 3600 }`). The wake-up id is `email-send-<sendId>-<attempts>`, and the handler returns normally for `not_due`, `provider_unavailable`, `not_claimable` and
`lost_claim`, so the finished job kept its id and swallowed every later wake-up with the same id (the reconciler's included) for up to an hour. Observed with the old options: the send stayed
unsent in all three skip paths until the retention expired.

Fix (`src/server/automation/queue/bullmq.ts`, `memory.ts`): email wake-ups are enqueued with `removeOnComplete: true` and `removeOnFail: true`, so their id only dedupes a job that is waiting,
delayed or running. Bounded and race-safe: no new jobs are generated (the maintenance pass still queues at most one wake-up per due send per pass); duplicate-send protection is unchanged
because it never depended on the queue (the database claim does); nothing accumulates in Redis; and a wake-up that arrives while the same id is RUNNING is dropped, which is covered by the
next maintenance pass (about a minute) because the database row is still due. Automation and customer-AI jobs keep their permanent deduplication.
Test types: `email-bullmq-wakeups.test.ts` is REAL BullMQ and Redis (skipped without `TEST_REDIS_URL` on database 15); `memory.test.ts` and the `RecordingQueue`/`FlakyQueue` doubles are
in-process doubles and prove nothing about BullMQ.

### Remaining blockers before a real provider (classified)

**Blockers** (nothing may send real mail until each is done): a real adapter with committed verification evidence and `readiness: "verified"` (none exists; `EMAIL_PROVIDER` accepts only `fake`;
`production-boundary.test.ts` guards this); credential storage, least privilege and rotation (undesigned); a bounce/complaint/receipt consumer and a suppression list (the contract exists, nothing
consumes it, so a hard-bouncing address is mailed again); DNS/domain authentication for outbound (SPF/DKIM/DMARC alignment for the sending domain).

**High**: a review path for held inbound mail (write-only today); a platform-operator role to replace the unauthenticated operator CLI label; a load/soak test of the outbox with real Redis and
several workers; BullMQ behaviour under a Redis restart and failover (the database recovers it, but it was not exercised); the residual frozen-process duplicate risk for lookup-only providers (above).

**Later**: per-plan or calendar-day quotas; a dead-letter state for poison domain events; retention for `outbound_email_audits`; a lease-extension write for repeated settle checks beyond one (not needed
by the current design); an attempt or retry count in the staff UI if one is ever wanted (neither the API nor the UI shows one today; if it is added it should be the retry budget, never the ownership counter).
