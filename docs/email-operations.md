# Email and domain events: operations

Observability, limits, alert thresholds and scheduled housekeeping for the inbound email channel and the durable
domain events. Companion to [email](email.md), the [audit](email-audit-9.2.md) and ADR
[016](decisions/016-durable-domain-events.md). Nothing here was exercised against a real provider.

## Sender authentication contract (summary)

Full text and rationale: `src/server/email/sender-auth.ts` (the schema is the contract; a violation makes the whole
message "malformed" and it is ignored, never guessed at).

| Field          | Shape                                     | Rule                                                                                                                                                                                        |
| -------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spf`          | `{result, domain}`                        | exactly one. `pass` needs the domain it passed for (MAIL FROM or HELO). `none` must have no domain. softfail, permerror, temperror are reported as `fail`                                   |
| `dkim`         | list of `{result, domain}` (0-10)         | one per evaluated signature; `pass` needs the signature's `d=` domain                                                                                                                       |
| alignment      | decided by the platform                   | authenticated domain equals the From domain, or is a parent of it (two or more labels, dot boundary). The reverse is NOT aligned (stricter than relaxed DMARC; needs no public-suffix list) |
| authenticated  | SPF aligned pass OR any DKIM aligned pass | an adapter-reported "pass" for another domain is stored as `fail`                                                                                                                           |
| unknown fields | rejected                                  | no `dmarc` field exists on purpose                                                                                                                                                          |

Stored: `spf` / `dkim` (the platform-evaluated verdict) and `authDetail` (the authenticated domains and per-signature
alignment), so a held message shows WHY it was held. Tests: `src/server/email/sender-auth.test.ts` with
15 scenarios in `tests/helpers/email-auth.ts` (forwarding, ESP bounce domains, a spoofer authenticating its own
domain, an extra foreign DKIM signature, look-alike domains, subdomains, case). The scenarios come from SPF/DKIM/DMARC
semantics; they are **not captured from any provider** and say nothing about how a provider reports its results.
Before a real adapter: confirm how that provider exposes the SPF/DKIM domains and write the mapping test against its documented payload.

## Metrics

Structured log lines, one per event, shape `{module:"metrics", metric, kind:"counter"|"gauge", value, ...labels}`, plus an
in-process registry. Labels are restricted to short codes and UUIDs (anything else becomes `other`), so an address, subject,
body or secret can never reach a log line through a metric (`src/server/observability/metrics.ts`).

| Metric                                                        | Labels                                                               | Meaning                                                                                                                                                                               |
| ------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_webhook_rejected_total`                                | `reason`: bad_signature, stale, malformed, too_large, not_configured | rejected before any state was touched                                                                                                                                                 |
| `email_fetch_unavailable_total`                               |                                                                      | a verified notification whose message could not be fetched (provider will retry)                                                                                                      |
| `email_inbound_total`                                         | `outcome`, `reason`, `organizationId`                                | processed / held (reason) / ignored (reason) / duplicate                                                                                                                              |
| `email_quota_exhausted_total`                                 | `scope`: organization, sender; `organizationId`                      | a volume bound dropped mail                                                                                                                                                           |
| `email_held_queue_saturated_total`                            | `scope`: queue, reason; `reason`, `organizationId`                   | held mail dropped because its queue is full                                                                                                                                           |
| `domain_event_outbox_total`                                   | `result`: recorded, published, failed, redelivered; `type`           | durable event lifecycle                                                                                                                                                               |
| gauges (maintenance, from the database, same on every worker) |                                                                      | `email_held_open{organizationId,reason}`, `email_dropped_last_hour{reason}`, `email_webhook_events_rows`, `domain_event_outbox_backlog`, `..._oldest_age_seconds`, `..._max_attempts` |

Counters are per instance; cross-instance totals come from the log pipeline (metric filters, log-based metrics). The gauges are
read from PostgreSQL, so they are identical from every worker and are the right basis for alerts. `organizationId` is a UUID
label: acceptable cardinality for tens or hundreds of tenants; aggregate it away if the tenant count grows into the thousands.

## Limits

Enforced exactly (per-organization lock, see the audit). Defaults in `INBOUND_LIMITS`:

| Limit                                                                                                 | Default            | Rationale                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| inbound emails per organization per hour                                                              | 500                | far above a real support inbox; a flood hits this before it hurts others                                                                      |
| per sender per hour                                                                                   | 20                 | one human or one ESP; a sender above this is a loop or abuse                                                                                  |
| open held mail per organization                                                                       | 200                | review is manual; more is unreviewable                                                                                                        |
| open held per reason: unauthenticated / archived customer / ambiguous thread / thread-sender mismatch | 100 / 50 / 25 / 25 | **a flood of the cheapest kind (spoofed mail) can no longer fill the queue legitimate held mail needs**; the sum stays within the overall cap |
| organizations per email                                                                               | 5                  | bounds fan-out                                                                                                                                |
| webhook body                                                                                          | 256 KiB            | it is a pointer, not the message                                                                                                              |

A message beyond a bound is acknowledged (HTTP 200) and dropped with a coded ledger entry: `rate_limited_organization`,
`rate_limited_sender`, `held_limit` (queue full), `held_limit_reason` (this kind is full). This is the documented policy.
It is lossy by design; the alerts below exist so a human sees it.

## Alert thresholds (proposals; tune with real traffic)

Evaluated by `evaluateAlerts` from the gauges on every maintenance pass and written as `warn`/`error` log lines
(`alert`, `value`, `threshold`: codes and numbers only). Wire the log pipeline to page on `error` and notify on `warn`.

| Alert                                      | Warn           | Critical                                            |
| ------------------------------------------ | -------------- | --------------------------------------------------- |
| domain events unpublished (oldest age)     | 5 min          | 30 min (realtime and automations are not firing)    |
| outbox backlog                             | 100 events     |                                                     |
| an event retried                           | 8 attempts     |                                                     |
| held queue of one kind                     | 80% of its cap | at the cap (new mail of that kind is being dropped) |
| quota exhausted in the last hour           | any            | 25 drops in an hour (an attack or a loop)           |
| mail dropped because a held queue was full |                | any                                                 |

Log-pipeline rules worth adding (counters, per instance, so use rates over several minutes): `bad_signature` or `stale` above
about 20 in 5 minutes (probing, or a rotated secret nobody updated); `bad_signature` with zero `processed` for 15 minutes (the
integration is down); `email_fetch_unavailable_total` above 5 in 10 minutes (provider API trouble).

## Outbound email operations (Phase 9.3A)

Metrics `email_outbound_total{result}` (sent, retry_scheduled, failed{reason}, unknown, ambiguous, recovered, skipped{reason}, stale,
finalize_failed, wakeup_failed) and gauges `email_outbound_due`, `email_outbound_oldest_due_age_seconds`, `email_outbound_unknown`.
Alerts: **due-but-unsent** email (a retry whose time came, a send nobody picked up, or an attempt whose worker died) at 10 min warn / 60 min
critical; **UNKNOWN** sends warn (an operator must decide; not a health failure). Work waiting by design (a scheduled retry) is not an alert. NEW in 9.4: **50 or more sends due at once** warns (the worker is not keeping up even if none is old yet); the thresholds 10 min / 60 min are unchanged. The "oldest due" age now takes the oldest of each kind (see [email-outbound](email-outbound.md#operational-safety-phase-94)). Gauges added: `email_outbound_processing`, `email_outbound_retry_waiting`, `email_outbound_expired_leases` (informational, never alerted).
Suggested log-pipeline rules: `finalize_failed` above 0 (database trouble while recording outcomes; recovery handles it, but investigate),
`stale` above 0 repeatedly (leases too short for the provider's latency), `wakeup_failed` bursts (Redis trouble; the reconciler covers it),
`failed{reason=permanent}` spikes (a bad sender configuration or a provider issue). Full behavior: [email-outbound](email-outbound.md).

## Worker health

`GET /api/health/background` (200 ok / 503 degraded; coarse states and ages only, no tenant data). It is separate from
`/api/health` on purpose: `/api/health` is the web tier's own check and may be wired to an orchestrator, and a stopped worker
must page someone, not remove web instances from rotation. Point an **external uptime monitor** at it (every minute, alert
after 2-3 consecutive failures); a dead worker cannot report itself, so the monitor must live outside it.

| Check      | Values                                    | Meaning                                                                                                                                                                                                                                   |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worker`   | `ok` / `stale` / `never` / `not_required` | last successful maintenance pass within 3 minutes / older / no pass ever recorded / no worker expected (plain development: in-process queue, not production)                                                                              |
| `events`   | `ok` / `delayed` / `stuck`                | oldest unpublished domain event under 5 min / over 5 min / over 30 min; computed from the events themselves, so it fires even if no worker ever ran                                                                                       |
| `outbound` | `ok` / `delayed` / `stuck`                | outbound email that is DUE but unsent: under 10 min / over 10 min / over 60 min; also computed from the database, so it fires with a dead worker. `details.unknownEmails`, `dueEmails` and `expiredEmailLeases` are informational numbers |

A worker is _required_ when `NODE_ENV=production` or the BullMQ driver is configured. The heartbeat is one row in
`worker_heartbeats` (additive migration); no new infrastructure. Deployment assumption: **at least one worker process
(`npm run worker`) runs in production**; with none, queued automations, customer AI replies, event retries and retention all
stop, and this check turns red. Graceful shutdown waits (up to 10 s) for an in-flight pass; a pass killed mid-way leaves
only short leases that the next worker takes over.

## Explicit behavior when limits are reached

| Situation                                                                                 | Behavior                                                                                                                             | Visible as                                                                                                                                      |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| organization hourly quota (500) reached                                                   | further mail is acknowledged (200) and **dropped**; spoofed (unauthenticated) mail never counts toward it                            | ledger reason `rate_limited_organization`, metric `email_quota_exhausted_total{scope=organization}`, alert (warn at 1, critical at 25 per hour) |
| one sender over 20/hour                                                                   | dropped, acknowledged                                                                                                                | `rate_limited_sender`                                                                                                                           |
| held queue of one kind full (unauthenticated 100, archived 50, ambiguous 25, mismatch 25) | that kind is dropped; other kinds still have room                                                                                    | `held_limit_reason`, `email_held_queue_saturated_total{scope=reason}`, critical alert                                                           |
| whole held queue full (200)                                                               | dropped                                                                                                                              | `held_limit`, `scope=queue`, critical alert                                                                                                     |
| held mail older than 30 days, unresolved                                                  | **discarded** by the hourly purge (floor 14 days and never below the replay span, because deleting a held row forgets its dedup key) | `email_held_expired_total`, log line with the count                                                                                             |
| replay-ledger entry                                                                       | kept 30 days by default, never fewer than 7, never fewer than twice the provider's replay span                                       |                                                                                                                                                 |
| published outbox row                                                                      | deleted after 7 days; unpublished rows are never deleted                                                                             |                                                                                                                                                 |

Dropping is lossy by design and acknowledged to the provider (a retry would not help). The alerts are what make it
non-silent. Held mail is, until the review workflow exists, **write-only**: nobody can read or release it, which is why
expiry exists and why enabling email for real customers is a prerequisite-gated step (see the readiness report).

## Scheduled housekeeping

Work that must repeat: re-publish unpublished domain events (every minute), expire replay-ledger entries and published
outbox rows (hourly), compute gauges (every minute). Options evaluated:

| Option                                                            | Cost                                                                                                                                                                         | Verdict                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **A timer inside the existing worker process** (`npm run worker`) | none: the worker already runs in production (automations, customer AI) and needs only PostgreSQL for this                                                                    | **chosen**                                    |
| BullMQ repeatable jobs                                            | a new job kind on the shared queue, Redis becomes the source of the schedule (a flushed Redis loses it until restart), and the in-memory development queue has no equivalent | rejected                                      |
| External cron calling an authenticated endpoint                   | a new secret and endpoint to secure                                                                                                                                          | only if a deployment has no worker; not built |
| `pg_cron`                                                         | database extension, not portable                                                                                                                                             | not needed                                    |

It is safe with any number of workers: outbox rows are claimed with conditional updates, deletes are idempotent, gauges are
read-only, and a slow pass never overlaps the next one in the same process. A deployment without the worker (the in-process
development queue) does not run it; nothing is lost, the work waits in the database. This is the same loop the outbound stage
(retries, delivery state recovery) and held-mail expiry use: **no scheduler was added for email alone.**

### Retention and provider retry horizons

Rule: a dedup key must live longer than anything that could replay it, namely the adapter's freshness window and the provider's retry horizon.

| Data                                                               | Retention                                                                                             | Floor / reason                                                                                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| replay ledger                                                      | 30 days                                                                                               | refuses fewer than 7 days; Mailgun documents retries for about 8 hours; **SES/SNS horizon is not verified**, confirm before the adapter    |
| published outbox rows                                              | 7 days                                                                                                | audit trail only                                                                                                                           |
| unpublished outbox rows                                            | never purged                                                                                          | an alert fires instead                                                                                                                     |
| held mail, unresolved (implemented)                                | 30 days, then discarded by the hourly purge (`email_held_expired_total` and a log line; no audit row) | must stay above the provider retry horizon, because deleting a held row forgets its `providerMessageId` (a late retry would be held again) |
| held mail, resolved (later phase: there is no review workflow yet) | drop the body after 90 days, keep metadata                                                            |                                                                                                                                            |
| `email_messages`                                                   | with the conversation                                                                                 | the permanent dedup record                                                                                                                 |

Held-mail expiry runs in the hourly purge step today (unresolved mail only). When the review workflow adds `resolvedByUserId`/`resolution`, resolved mail will additionally lose its body after 90 days.

## What distinguishes the outbound situations (Phase 9.4)

| Situation                                               | What you see                                                                                                               | Alert                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Healthy queue, retries waiting for their scheduled time | `retryWaiting` > 0, `due` = 0; not in the attention view                                                                   | none                                                                  |
| Normal in-flight work                                   | `processing` > 0 with a valid lease; not listed                                                                            | none                                                                  |
| Worker stopped or cannot reach the provider             | `due` > 0 and its age grows; sends appear as `queued_overdue` / `retry_overdue` after 10 minutes; the heartbeat goes stale | delayed at 10 min, stuck at 60 min; `/api/health/background` degraded |
| A worker died holding a send                            | `expiredLeases` > 0; listed as `lease_expired` after 2 more minutes; recovered automatically once any worker runs          | same age alerts                                                       |
| Backlog the worker cannot keep up with                  | `due` >= 50                                                                                                                | `email_outbound_backlog` (warn)                                       |
| Outcome unknown                                         | `unknown` > 0; listed as `unknown`                                                                                         | `email_outbound_unknown` (warn); not a health failure                 |

`/api/health/background` is unauthenticated and returns only coarse states and counts (no tenant data, no addresses); the organization-scoped
detail lives in the authenticated attention view. A platform-wide authenticated view does not exist (no platform-operator role).

## Outbound abuse limits and provider assessment (Phase 9.6)

| Metric                                                            | Meaning                                                                                                                                                           |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `email_outbound_rejected_total{reason}`                           | a reply was refused by a limit: `org_day` (daily quota exhausted: also logged at warn), `org_minute`, `user_minute`, `recipient_hour`                             |
| `email_provider_rejected_total{reason}`                           | the configured provider is refused for SENDING (inconsistent or weak capability declarations, or not verified in production); outbound is unavailable until fixed |
| `email_outbound_total{result="settle_pending"}`                   | an ambiguous attempt whose lookup said "not found" before the settle window: waiting, nothing resent                                                              |
| `email_outbound_total{result="lease_too_short"}`                  | the final lease check failed after the extension (the clock jumped): nothing was sent, a retry was scheduled WITHOUT using retry budget                           |
| `email_outbound_total{result="recovered", reason="await_settle"}` | recovery found the window not yet over; asks again next pass                                                                                                      |

Alert proposals: any `email_provider_rejected_total` in production (page: no customer email is leaving); `org_day` rejections for one organization (a quota
conversation, or abuse); a sustained `org_minute` or `user_minute` rate (a script is sending). Limits are per organization and the same for all of them; to raise one
temporarily set the `EMAIL_OUTBOUND_*` variable (ceilings 600 per minute, 100000 per day, 120 per account per minute, 100 per recipient per hour) and restart.
A refused reply is not queued: the staff member is told to try again shortly (generic message, `Retry-After`).

Re-check outcomes: **inconclusive** means the provider says "no record" but the lookup no longer remembers that far back; the send stays UNKNOWN. The age needed before any
re-check or operator resolution is `max(10 minutes, the claim's lease + the provider's settle window)` (`resolveGuardMs`).

Phase 9.7 additions: `email_outbound_total{result="lease_extended"}` (a claim moved its own lease so the provider's settle window fits; normal under a slow database, a rising rate means the
database or the worker is slow), `{result="lease_extend_refused"}` (the extension was refused: recovery took the send over, or the database failed; no call was made; investigate if sustained),
`{result="recovered", reason="await_settle"}` (recovery found a settle window open and moved the lease to its end). Email wake-up jobs are removed from Redis as soon as they finish, so the queue's
completed/failed sets hold no email jobs; a wake-up that arrives while the same id is running is dropped and re-queued by the next maintenance pass (at most about a minute of delay).
