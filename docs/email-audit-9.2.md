# Phase 9.2 security and reliability audit

> **Historical report (Phase 9.2).** A point-in-time audit of the inbound email stage as it was then. Phases 9.3 to 9.7 changed the code afterwards; for current behavior see [email](email.md), [outbound](email-outbound.md) and [operations](email-operations.md).

Scope: the inbound email implementation (webhook, ingestion, threading, ledger, limits, held mail) and the two
refactors it needed. Method: read the actual code paths, write tests for each suspected gap against the code
as delivered, keep the ones that failed as regression tests, fix, and re-run. **No provider-level security is
verified:** there is no real provider, DNS or credentials; everything below was exercised against the fake
provider and a real PostgreSQL.

## Confirmed defects (all fixed, each with a regression test in `tests/integration/email-inbound-audit.test.ts`)

| #   | Defect                                                                                                                                                                                                            | Evidence before the fix                                                                                     | Fix                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Poison message.** To/Cc and the display name were stored as received. A NUL byte (rejected by PostgreSQL) made the insert throw, so the webhook answered 500 and the provider retried the same message forever. | An email with NUL in To/Cc/From name threw `PrismaClientKnownRequestError`.                                 | All stored header values are cleaned (`cleanDisplayName`, `cleanAddressList`, subject, filenames); provider message ids reject control characters in the schema; CHECK constraints in the new migration `email_inbound_hardening`. |
| 2   | **Caps were not exact under concurrency** (count-then-insert race): per sender, per organization and the held queue.                                                                                              | 12 concurrent emails from one sender stored 12 (cap 3); organization cap 4 stored 10; held cap 3 stored 10. | Ingestion takes a transaction-scoped advisory lock **per organization** and re-checks duplicate and caps inside it. Other organizations never wait. A cheap unlocked pre-check still sheds floods early.                           |
| 3   | **Unbounded body buffering.** The 256 KiB limit was checked after `request.text()` and trusted `Content-Length`; a chunked body without it was read in full first.                                                | 8.4 MB pulled from the stream before the 413.                                                               | `readBodyWithLimit` counts bytes while reading and cancels the stream at the limit (also covers a false Content-Length).                                                                                                           |
| 4   | **Concurrent customer messages reopened a conversation more than once** (any channel, not only email): duplicate `STATUS_CHANGED` events and automation triggers.                                                 | 3 events for 3 concurrent replies to a RESOLVED thread.                                                     | `persistMessageInTransaction` takes the conversation row lock before reading state. The new test fails if the lock is removed (mutation-checked).                                                                                  |
| 5   | **A failure while announcing a committed message** (realtime/automation) would surface as a 500; the retry then saw a duplicate and could never announce it.                                                      | `emitDomainEvent` rejecting made the webhook throw after the commit.                                        | Announcement is best effort and isolated: logged, the response stays 200.                                                                                                                                                          |
| 6   | **Webhook accepted with a provider but no platform domain.** Loop protection (own-domain senders) silently turns off.                                                                                             | 200 with `EMAIL_PLATFORM_DOMAIN` unset.                                                                     | 404 unless the provider AND the domain are configured.                                                                                                                                                                             |
| 7   | **Bidirectional override characters** (U+202A-202E, U+2066-2069) were kept in names, subjects, filenames and text, allowing display spoofing (`exe.pdf` shown as `fdp.exe`).                                      | Stored unchanged.                                                                                           | Removed everywhere; direction marks (LRM/RLM) and genuine RTL text are preserved (tested).                                                                                                                                         |

Verified correct (no change needed): verdicts never come from sender-controlled content (the platform never
parses headers or body for authentication; verdicts arrive only in the adapter result and are schema-checked);
missing, malformed, upper-case, padded, non-boolean verdicts are rejected as malformed; the held-mail table is
reachable only from the ingestion code (a guard test fails if any route, service or UI starts reading it);
threading and customer lookups are always scoped by organization; the replay ledger holds no tenant data;
a purged ledger entry still cannot cause a duplicate; one organization failing mid-way does not lose the other.

## Webhook order of checks

1. Provider and platform domain configured (else 404). 2. Body read with a hard byte limit (else 413).
2. Adapter `verifyWebhook`: signature, freshness, payload shape (else 401 / 400). 4. Replay ledger lookup (no
   fetch for a replay). 5. Authenticated fetch of the message. 6. Schema validation of the fetched message.
3. Per organization, under its lock: duplicate, caps, authentication verdict, threading, customer, store.
4. Ledger entry written. Nothing before step 3 reads or writes application state.

## Retention design (proposal; the ledger purge itself is implemented)

- **Replay ledger (`email_webhook_events`).** An entry must outlive the time in which the same notification
  could be accepted again: the adapter's freshness window plus the provider's retry horizon (SNS and Mailgun
  retry for hours to days). After that a replay is refused as stale, and even one that got through is
  deduplicated by the stored `(organizationId, providerMessageId)`. Default retention **30 days**, floor
  **7 days** (`purgeExpiredWebhookEvents` refuses less, so a misconfigured job cannot weaken replay
  protection). It deletes by `createdAt` only and uses the existing index. It needs a scheduled caller; the
  platform has no scheduler yet, so wire it to the future worker or a cron in 9.6.
- **Adapter rule that makes this safe:** the freshness window must be at least as long as the provider's
  retry horizon, or a retry carrying the original timestamp is refused as stale and the message is lost
  (SNS retries re-send the original message). If the window is long, the ledger retention must exceed it.
- **Dedup that must never be purged early:** `email_messages.providerMessageId` lives as long as the message.
- **Held mail:** unresolved entries expire after 30 days (discard with an audit record), resolved entries keep
  metadata only (drop the body) for 90 days. Erasure of a customer also deletes held mail from their address.

## Held-mail review workflow (proposal for a later phase; nothing built)

- **Access:** a new permission `review_held_email` (ADMIN/OWNER first), organization-scoped like everything else;
  MEMBER cannot see held mail. Held bodies are never returned by list endpoints (metadata and a short sanitized
  preview only); the full text is fetched one at a time on an explicit "open".
- **Actions (each a POST, idempotent, conditional on `resolvedAt IS NULL`, audited):**
  _Discard_; _Attach to existing conversation_ (staff chooses the conversation, never inferred); _Create
  conversation for customer_ (staff chooses an existing customer or confirms creating one). Releasing a
  message held as `UNAUTHENTICATED_SENDER` requires an explicit acknowledgement and marks the stored message
  "sender not verified" so nobody treats it as authentic; it never creates or merges a customer silently.
- **Mechanics:** release runs through `persistMessageInTransaction` in one transaction with the `resolvedAt`
  update, so it cannot happen twice or half-way; events are announced after commit like every other message.
- **Auditability:** add `resolvedByUserId`, `resolution` (`DISCARDED | ATTACHED | RELEASED`) and
  `resolvedConversationId` columns; record a conversation event for releases and a log entry (ids only) for
  discards. Never log addresses or content.
- **Abuse:** per-reason queue caps (see H3), per-sender block list, and a daily digest instead of a UI
  notification per message.

## Hardening recommendations

**Status after the follow-up pass** ([email-operations.md](email-operations.md), ADR [016](decisions/016-durable-domain-events.md)): H1 done (sender-authentication contract with domains; the platform decides alignment); H2 done for the shared message/conversation path and inbound email (durable outbox; other emit sites listed in the ADR); H3 partly done (per-reason held caps, metrics, gauges, alerts; holding instead of dropping on the organization cap is still open); H4 and H6 unchanged (the lock is bounded by the early shed); H5 extended by the contract; scheduling of the purge is done (worker timer). Original text:

- **H1. Check alignment in the platform, not only in the adapter.** `senderAuth.spf/dkim = "pass"` currently
  means "the adapter says aligned pass". A buggy adapter that reports an unaligned pass (for example SPF
  passing for the spoofer's own domain) would defeat the held-mail protection. Extend the contract so each
  verdict carries the authenticated domain and let the platform compare it with the From domain. Do this
  before the first real adapter.
- **H2. Do not lose events on a crash between commit and announcement.** A process crash in that gap loses the
  realtime hint and the automation trigger (the retry sees a duplicate). Options: an `announcedAt` marker on
  `email_messages` re-announced on the duplicate path with a stable event id (the automation engine already
  deduplicates by event id), or a general transactional outbox for domain events (also helps other channels).
- **H3. Flood-resistance of the quotas.** An authenticated or spoofed flood fills the organization's hourly
  quota and the held queue (200), after which legitimate mail is acknowledged and dropped. Add per-reason
  sub-caps so unauthenticated mail cannot consume the whole queue, a counter or alert on drops, and consider
  holding rather than dropping on the organization cap. Dropped mail is, by documented policy, acknowledged
  (200) with a coded ledger entry; that policy is lossy by design.
- **H4. Advisory lock under heavy bursts.** The per-organization lock serializes ingestion for one tenant. A
  burst can hold database connections while waiting (the interactive transaction timeout is 5 s by default,
  after which the provider retries). The early shed limits this; if bursts matter, move ingestion behind a
  per-organization queue or set an explicit transaction timeout.
- **H5. Adapter obligations** (add to the adapter contract tests when a real adapter is written): replay key is
  namespaced by provider, account and event id; `deliveredTo` comes from the SMTP envelope, never from the
  To header; `automated` covers Auto-Submitted, Precedence bulk/list/junk, X-Auto-Response-Suppress, List-Id and an
  empty Return-Path; HTML is converted to text by the adapter (the platform never renders email HTML);
  a size limit is applied before the body is read; verdicts follow H1.
- **H6. IP or rate limiting in front of the webhook** (cheap signature failures are already constant-time
  and stateless, but a flood still costs CPU and log volume; rate-limit warn logs for rejected requests).
- **H7. Quoted reply history** is stored as received; stripping it is a heuristic that can hide real text.

## Migration review

`email_inbound` and `email_inbound_hardening` are additive. Constraints match behavior: lower-case sender,
verdict values, header-id shape, bounded lists, coded ledger reasons (9.2); no control or bidi characters in
names, subjects and ids, and a sender address shape (hardening). `[[:cntrl:]]` was avoided for non-ASCII because
PostgreSQL's class is locale-dependent (it flagged a harmless RTL mark and missed a bidi override in the test
environment); explicit code-point ranges are used. Neither migration has been applied to the real database.
