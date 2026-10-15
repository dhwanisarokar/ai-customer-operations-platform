# Email channel (Phase 9)

Email becomes a first-class Inbox channel: customers email an organization's support address, the thread
appears in the Inbox, staff reply from there, and replies go out by email. Phase 9 is delivered in stages;
**this document describes what exists after Phase 9.2 (foundation + inbound processing)** and what is
deliberately not built yet.

Later phases are described elsewhere: outbound delivery (9.3 to 9.7: durable outbox, retries, ambiguous-outcome safety, abuse limits, staff inbox integration, fake provider only) in [email-outbound.md](email-outbound.md); operations in [email-operations.md](email-operations.md); what a real provider needs before it can be enabled in [email-provider-readiness.md](email-provider-readiness.md). **No real email provider is configured or implemented.** The acceptance checklists below are the 9.1 and 9.2 ones, kept as written.

## Scope decisions (approved)

- Email is a new Inbox channel (`ConversationChannel.EMAIL`), not a parallel product.
- Platform-controlled, organization-specific addresses first: `<name>@<EMAIL_PLATFORM_DOMAIN>`. Custom
  domains are deferred.
- Plain text only. Attachments are metadata only: never downloaded, stored or served in v1.
- Threading uses RFC headers only (`In-Reply-To`, `References`, our own `Message-ID`s). Never the subject alone.
- Archived or ambiguous customer matches are held for staff review, not auto-attached.
- A reply on a RESOLVED conversation reopens it (existing behavior). CC recipients are recorded as metadata;
  replies never go to CC.
- No autonomous AI email replies and no automation-triggered customer emails in v1. AI drafts stay human-reviewed.
  `customerAiEnabledFor` returns false for `EMAIL`.

## What 9.1 contains

| Piece                     | Where                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Channel + settings schema | `ConversationChannel.EMAIL`, table `email_settings` (migration `20261013000000_email_foundation`) |
| Address rules             | `src/server/email/address.ts` (pure, tested)                                                      |
| Provider boundary         | `src/server/email/provider.ts` (`EmailProvider`, bounded `NormalizedInboundEmail`)                |
| Fake provider             | `src/server/email/fake-provider.ts` (tests and local development only)                            |
| Provider selection        | `src/server/email/index.ts` (`EMAIL_PROVIDER`, `EMAIL_PLATFORM_DOMAIN`)                           |
| Settings service + API    | `src/server/email/settings.ts`, `/api/email-settings`, `/verify`, `/enabled`                      |
| Permission                | `manage_email` (ADMIN, OWNER)                                                                     |
| UI                        | "Email" card on `/dashboard/widget` for users with `manage_email`                                 |

Phase 9.2 builds on this and is described in [Inbound processing (9.2)](#inbound-processing-92).

### Settings state machine

`UNCONFIGURED` (no row; reading never creates one) -> save an address -> `PENDING_VERIFICATION` (disabled) ->
verify -> `ACTIVE` or `FAILED` (with a short machine code, never provider text). Enabling requires `ACTIVE`
(conditional update, plus the CHECK `NOT enabled OR status = 'ACTIVE'`). Changing the address resets to
`PENDING_VERIFICATION` and disables; changing only the sender name keeps verification. A failed re-verification
switches the channel off. The organization is always the caller's (from the session); a request body that
contains `organizationId`, `status` or `supportAddress` is rejected (strict schemas).

### Database guarantees (`email_settings`)

`organizationId` unique and cascade on delete; `supportAddress` globally unique (the future routing key);
CHECKs: enabled requires ACTIVE; lower-case address whose local part equals the stored `localPart`; local
part format and length; sender name non-blank, at most 80 characters, no control characters; status detail is
a short code. The services also validate, but the database holds even if they are bypassed.

### Configuration

`EMAIL_PROVIDER` (`fake` only for now; the fake provider is refused when `NODE_ENV=production`) and
`EMAIL_PLATFORM_DOMAIN` (a plain domain). With either missing the channel is "not available" and every
organization stays off. No provider credentials exist in 9.1.

## The adapter contract

Conversation logic imports only `src/server/email`, never a provider. An adapter implements:

- `ensureAddress(address)` - make mail for the address arrive and be sendable from; idempotent.
- `verifyWebhook({headers, rawBody, now})` - authenticate a request and return a **reference** plus a
  single-use `replayKey`, or a typed rejection (`bad_signature`, `stale`, `malformed`). It never trusts any
  organization, recipient or sender field in the payload.
- `fetchInboundEmail(ref)` - the authoritative message over the provider's **authenticated API**, parsed into
  the bounded `NormalizedInboundEmail` (text <= 100k chars, bounded recipients/attachments/references).
- `sendEmail(message)` - classified result (`retryable` or not), never throws for provider errors, refuses
  header injection (CR/LF/control characters), idempotent per `idempotencyKey`.

`tests/helpers/email-provider-contract.ts` is a shared contract suite every adapter must pass.

**Design principle: integrity of content comes from the provider's authenticated API, not from the webhook
body.** A webhook is only a verified notification. This keeps the platform safe even with providers whose
signature does not cover the request body (see below).

## Provider verification findings (must be read before choosing a provider)

Checked against the providers' public documentation (not against a live account; no credentials or DNS were
used):

- **Mailgun inbound routes**: the documented signature is `HMAC-SHA256(signing key, timestamp + token)`. The
  request **body is not covered** for form-encoded/multipart routes; `timestamp`, `token` and `signature` are
  body fields. Replay protection (a token cache and a timestamp window) is the caller's job, and the sample
  code uses a plain string comparison. Documentation for JSON-posted routes says the entire body is used in
  place of the token and sends the values as `X-Mailgun-*` headers, which contradicts the securing-webhooks
  page; **this must be verified empirically before relying on it**. `Message-Id` is only available inside
  `message-headers`. Delivery semantics: HTTP 200 accepted, 406 rejected without retry, other statuses
  retried for several hours. Per-organization DKIM would use the Domains API; DNS propagation can take
  24-48 hours. Inbound size limits and message retrieval retention were not confirmed.
- **Resend**: webhooks use Svix signatures over the full body. Inbound is private beta and the webhook is
  metadata-only (the body is fetched via the Receiving API). Supports an `Idempotency-Key` on send;
  control of `Message-ID`/`References` is unconfirmed.
- **Postmark**: inbound webhooks have no HMAC (basic auth or IP allow-listing only).

Consequence: with Mailgun, an attacker who knows or guesses a valid `timestamp`/`token`/`signature` triple
(for example from a log) could replay it with a **different body**. The mitigation built into the contract is
that the body is never trusted: only the signed reference is used and the message is fetched over the
authenticated API (Mailgun `store()` plus the notify URL), plus a single-use `replayKey` and a freshness
window. That depends on Mailgun's retrieval API behaving as documented, which is not yet verified.
**Provider status:** Amazon SES is the preferred production candidate, subject to confirming the final
architecture and operational costs (ADR 015). No real adapter exists or is configured; everything below is
provider-neutral and runs against the fake provider.

## Acceptance checklist for 9.1

- [x] `EMAIL` channel value and `email_settings` added by an additive migration; applies to a fresh database
      and to a database with existing data without changing it (verified on scratch databases).
- [x] Settings are per organization, disabled by default, never created by reading.
- [x] `manage_email` gates every endpoint; MEMBER 403, anonymous 401.
- [x] Addresses are validated, normalized, reserved names refused, globally unique case-insensitively.
- [x] Verification is a state machine enforced in the service and in the database.
- [x] Provider boundary and contract tests exist; fake provider mirrors a strong (body-signing) provider.
- [x] No autonomous AI replies on EMAIL.
- [x] No secrets, no provider credentials, no inbound or outbound mail paths are added.
- [ ] A real provider adapter, inbound ingestion, outbound delivery: later stages, pending review.

## Inbound processing (9.2)

Operations (metrics, limits, alert thresholds, scheduled housekeeping, the sender-authentication contract summary) are in [email-operations.md](email-operations.md); durable events are ADR [016](decisions/016-durable-domain-events.md). The security and reliability audit of this stage, its fixes, the retention design and the held-mail review proposal are in [email-audit-9.2.md](email-audit-9.2.md).

The flow for one provider notification, in `src/server/email/inbound-webhook.ts` and `inbound.ts`:

```
POST /api/email/inbound
  -> size cap (256 KiB; the body is a pointer, not the message)
  -> provider.verifyWebhook(headers, rawBody)       signature + freshness, else 401 / 400
  -> replay ledger lookup (single-use key)          already consumed -> 200 "duplicate", no fetch
  -> provider.fetchInboundEmail(ref)                authenticated API; not found -> 503 (provider retries)
  -> ingestInboundEmail(email)                      one result per organization addressed
  -> record the replay key + outcome                (content-free)
```

Responses: 2xx means done (also for duplicates, held and ignored mail), 4xx means rejected and not worth
retrying, 5xx means retry. With no provider configured the endpoint answers 404. The route is excluded from the
Clerk middleware (`src/proxy.ts`) because it is a server-to-server call; it authenticates only by the
provider's signature. **There is no verification bypass:** the fake provider cannot be configured in
production (env validation), and a request that no configured provider signed never reaches any state.

### Organization resolution

Only the **envelope recipients** (`deliveredTo`, what the provider accepted the mail for) are looked up in the
ENABLED, verified support addresses (`email_settings`). The `To`/`Cc` headers are chosen by the sender and are
never used for routing. No match: the email is ignored (`unknown_recipient`). One email can address several
organizations (at most 5); each receives its own isolated copy.

### Decisions, in order (per organization)

1. Dropped before anything is stored: mail from the platform's own domain (loops), from `mailer-daemon` /
   `postmaster`, or flagged `automated` by the adapter; invalid sender address; limits (see below).
2. Already seen (`providerMessageId` stored or held) -> duplicate.
3. Sender not authenticated (neither SPF nor DKIM passed FOR THE FROM DOMAIN; the adapter reports the passing domains and the platform decides alignment, see the contract in [email-operations.md](email-operations.md)) -> **held**
   (`UNAUTHENTICATED_SENDER`). A spoofed From never attaches to, or creates, a customer.
4. Threading by RFC headers only, looked up inside this organization: `In-Reply-To` first, then
   `References`. Headers pointing at two or more conversations -> **held** (`AMBIGUOUS_THREAD`). The subject
   is never used. Message-IDs of other organizations are simply unknown here.
5. Customer by the (lowercased) sender address, unique per organization. An ARCHIVED customer -> **held**
   (`ARCHIVED_CUSTOMER`). A thread whose customer is not the sender -> **held** (`THREAD_SENDER_MISMATCH`).
   Nobody found -> a customer is created (source `email`, activity `CUSTOMER_CREATED` by SYSTEM).
6. Stored in ONE transaction: customer (if new), conversation (if new: channel `EMAIL`, handling mode HUMAN),
   the message through the shared `persistMessageInTransaction` (same rules as every channel: preview,
   unread, reopen on reply with `STATUS_CHANGED`, events), and the `email_messages` row. Domain events
   (`customer.created`, `conversation.created`, `message.created`, `conversation.status_changed`) are emitted
   after the commit through the durable outbox (they survive a crash between commit and publication), so realtime and automations behave as for web chat and the portal.

Held mail goes to `email_held_messages` (bounded text, never rendered as HTML) with its reason. The review
actions (attach, create customer, discard) are a later stage; until then held mail is only stored.

### Content handling

Plain text only. Bodies lose control characters, get LF line endings and are cut to the 10,000-character
message limit with a note (an empty body becomes a placeholder). Subjects are one line, bounded, and lose
`Re:`/`Fwd:` prefixes for the new conversation's subject. Display names are sanitized before becoming a first
name. Attachments are recorded as metadata only (name, type, size) and never downloaded. CC and To are
recorded as metadata; nothing is ever sent to them. Quoted reply history is not stripped (a heuristic that
can hide real text); it is a known limitation.

### Idempotency, replay and concurrency

- The replay ledger (`email_webhook_events`, unique `replayKey`) makes a replayed or retried notification a
  no-op before any fetch. It stores outcome codes only: no addresses and no content.
- `providerMessageId` is unique per organization across `email_messages` and `email_held_messages`, so the
  same message arriving through a different notification is also stored once.
- Concurrent identical deliveries store one message; concurrent first emails of one new sender create one
  customer (a unique-violation retry finds the customer the other request created).
- A failure anywhere in the transaction rolls everything back and nothing is recorded, so the provider's retry
  succeeds. Fetch errors are 5xx for the same reason.

### Abuse bounds

The bounds are exact: ingestion takes a per-organization advisory lock and checks duplicate and caps inside the transaction.

Per organization 500 inbound emails/hour, per sender 20/hour, at most 200 unresolved held emails, at most 5
organizations per email, 256 KiB webhook body. Beyond a bound the email is acknowledged and dropped (outcome
`IGNORED` in the ledger), never retried. `purgeExpiredWebhookEvents` (30-day default, 7-day floor) removes old ledger entries; it still needs a scheduled caller (a later stage).

### AI and handling mode

Email conversations start in HUMAN mode and `customerAiEnabledFor` is false for `EMAIL`: no automatic AI
reply is ever queued for them. Staff can still draft with AI and review it.

### Limitations of 9.2

- Staff replies on an email conversation are sent by email through the durable outbound foundation (9.3A) from the inbox composer (9.3B, `POST .../email-reply`), with the fake provider only: no real provider can be configured yet, so nothing reaches a real customer. See [email-outbound](email-outbound.md).
  Email cannot reach a real customer in this stage because no real provider can be configured.
- Delivery receipts (`delivery` notifications) are acknowledged and ignored.
- No real adapter: `fetchInboundEmail` is exercised against the fake provider and the shared contract suite
  only. A real adapter must report the SPF result and every DKIM signature WITH the domains they passed for (the platform decides alignment) and its envelope recipient
  as `deliveredTo`.
- Held-mail review UI/actions, scheduling of the ledger purge and per-organization quotas in settings are later stages.

## Acceptance checklist for 9.2

- [x] Organization resolved only from enabled, verified support addresses by envelope recipient.
- [x] Signature, freshness, replay and size checks precede all state; no bypass; 404 without a provider.
- [x] Matching, threading (RFC headers only), reopen-on-reply and CC handling as approved.
- [x] Spoofed senders, archived customers, ambiguous threads, foreign threads: held, never attached.
- [x] Malformed adapter output ignored; content bounded and sanitized; attachments metadata only.
- [x] One transaction per ingestion; events after commit; realtime and automations unchanged; no AI replies.
- [x] Additive migration `20261014000000_email_inbound`, applied to scratch databases only.
- [ ] Outbound delivery, delivery state, bounces: Phase 9.3.
