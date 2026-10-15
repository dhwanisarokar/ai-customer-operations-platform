# Real-adapter contract (provider-neutral)

Everything a provider adapter must satisfy before it can be connected. The shared contract suite
(`tests/helpers/email-provider-contract.ts`) enforces what is testable against a harness; the rest is a checklist
that needs a real provider account to confirm. **No real provider exists yet: nothing below has been verified
against one, and Amazon SES (the preferred candidate) is described only by what must be confirmed.**

## Interface (`src/server/email/provider.ts`)

| Member                                   | Obligation                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                   | short stable code, lower-case; prefixes every replay key                                                                                                                                                                                                                          |
| `replay`                                 | `{freshnessSeconds, retryHorizonSeconds, retriesResigned}`, checked by `assertReplayPolicy`                                                                                                                                                                                       |
| `ensureAddress(address)`                 | idempotent; the address on the platform domain receives mail and can be sent from                                                                                                                                                                                                 |
| `verifyWebhook({headers, rawBody, now})` | authenticate the exact bytes received; never throws; see below                                                                                                                                                                                                                    |
| `fetchInboundEmail(ref)`                 | the message over the provider's AUTHENTICATED API, never from the webhook body                                                                                                                                                                                                    |
| `sending`                                | `SendingCapabilities`: what the provider PROMISES about duplicate sends (idempotency and key retention, lookup, its consistency, retention and the late-acceptance ceiling). Unknown is `null`/false until verified; the ambiguous-outcome policy depends on them (see section 7) |
| `readiness`                              | `fake` / `declared` / `verified` (+ evidence path). Production accepts only `verified`; see [email-provider-readiness](email-provider-readiness.md)                                                                                                                               |
| `sendEmail(message)`                     | one of four classes (success, permanent failure, retryable failure, AMBIGUOUS), never throws, refuses header injection, accepts our `Message-ID`/`In-Reply-To`/`References` and uses `idempotencyKey` (the send id)                                                               |
| `findSendByKey(key)`                     | only when `sending.lookupByKey`: `found` / `not_found` / `unavailable`; `not_found` must be AUTHORITATIVE                                                                                                                                                                         |

## 1. Signature and payload validation (`verifyWebhook`)

- Verify over the exact raw body and headers, in constant time, with the provider's documented algorithm. If the signature
  does not cover the body, the body is still never trusted: only a signed reference is used and the content is fetched
  over the authenticated API.
- Return `bad_signature` (wrong or missing proof), `stale` (outside the freshness window), `malformed` (parseable proof
  but invalid payload). Never throw on garbage input.
- Reject a notification for a topic/account/domain other than the platform's own (for SNS-style systems: pin the topic and
  validate the certificate origin before trusting any field).
- Do not read organization, recipient or sender data from the notification to make decisions: only a reference and a replay key.

## 2. Freshness, retries and the replay key (`ReplayPolicy`)

| Fact                  | Rule                                                                | Why                                                                                                                    |
| --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `freshnessSeconds`    | positive; the window `verifyWebhook` enforces                       | limits replay of a captured request                                                                                    |
| `retryHorizonSeconds` | documented, from the provider's own docs (never assumed)            | how long un-acked notifications are re-sent                                                                            |
| `retriesResigned`     | true only if every retry is signed afresh                           | otherwise a retry carries the ORIGINAL timestamp                                                                       |
| invariant             | `retriesResigned \|\| freshnessSeconds >= retryHorizonSeconds`      | else the provider's own retries are refused as stale and the message is lost                                           |
| ledger retention      | derived: twice `(freshness + horizon)`, at least 7 days, default 30 | the ledger must outlive any replay; `purgeExpiredWebhookEvents` and held-mail expiry enforce it from `provider.replay` |

Replay key: `"<provider.name>:<account or domain id>:<provider event id>"`, at most 300 characters, no whitespace or control
characters, and **identical for every re-delivery of the same notification** (a retry must hit the ledger). Two different
notifications must never share a key (a collision would silently drop mail as "duplicate"). Contract tests cover namespacing,
bounds, stability and uniqueness.

## 3. Envelope recipients (`deliveredTo`)

`deliveredTo` MUST be the SMTP envelope recipient(s) the provider accepted the message for. Never copy the `To`/`Cc`
headers into it: those are chosen by the sender, and the platform routes an email to an organization only by this
field. (A bug here would let a sender mail organization B's address while delivering to A.)

## 4. Authenticated sender domains (`senderAuth`)

Full rules: `src/server/email/sender-auth.ts` and [email-operations](email-operations.md#sender-authentication-contract-summary).
Report one SPF result and each evaluated DKIM signature, WITH the domain each passed for. The platform decides alignment.

**Likely hard part, not verified:** some providers expose only a bare verdict ("SPF pass", "DKIM pass") with no authenticated
domain. Such an adapter cannot satisfy this contract by relaying the verdict. Options, to be decided per provider with the
real payload in hand: (a) the provider also exposes the domains (use them); (b) the provider stamps an
`Authentication-Results` header on the message and the adapter parses ONLY that provider-added header, after confirming
the provider strips any sender-supplied copy; (c) the adapter verifies DKIM itself from the raw message. Until one of these
is confirmed, do not map a bare verdict to `pass` with a guessed domain: report `none`.

## 5. Automated mail and loops (`automated`)

True for any of: `Auto-Submitted` other than `no`, `Precedence: bulk|list|junk`, `X-Auto-Response-Suppress`, `List-Id` /
`List-Unsubscribe`, a null `Return-Path` (bounces), delivery-status or auto-reply content types. The platform additionally
drops mail from its own domain and from mailer-daemon/postmaster senders.

## 6. Content and size

- Plain text only: the adapter converts HTML to text (the platform never renders email HTML and never stores it).
- The adapter bounds work before reading large bodies; the platform schema bounds what it accepts (text 100k characters,
  50 recipients/attachments/references) and cuts stored text to the 10,000-character message limit.
- Attachments: metadata only (filename, type, size); never downloaded or served in this version.
- Message-ID, In-Reply-To and References are passed as received; the platform validates their shape.

## 7. Sending (outbound, Phase 9.3A)

- **Result classes.** Report exactly one of: success (`providerMessageId`); permanent failure (`retryable: false`: a definite refusal such as an invalid mailbox); retryable failure (`retryable: true`: definitely NOT accepted, such as a rate limit or a 5xx before acceptance); **ambiguous** (`ambiguous: true`: the request may have been accepted but the answer was lost, such as a timeout after the request was sent or a connection reset while reading the response). When in doubt it is ambiguous, not a failure: calling it a retryable failure would invite a duplicate. Codes are short machine codes, never provider text.
- **Declare capabilities honestly, with numbers.** `idempotentByKey` is true only if the provider REFUSES a second delivery for the same key (including a concurrent one) and returns the original result, with `keyRetentionMs` at least `requiredKeyRetentionMs()` (shorter = declare false; a true declaration with a shorter figure is REFUSED at startup of sending). `lookupByKey` is true only if the lookup is AUTHORITATIVE and you state its `lookupConsistency` (`strong` or `eventual` with `lookupSettleMs`), its `lookupRetentionMs` and `lateAcceptanceCeilingMs` (how long after sending a request may still be accepted; leave it `null` if unknown and the lookup will not be used to retry). `not_found` must mean nothing was accepted for that key once the settle window has passed.
- **Use the key.** Send `idempotencyKey` (the send id) on every attempt through whatever mechanism the provider offers; send our `Message-ID`, `In-Reply-To` and `References` unchanged and in full (a provider that rewrites `Message-ID` breaks threading: verify it does not).
- **Bound the call.** The worker times the call out at 45 s and treats the outcome as ambiguous; an adapter should use a shorter client timeout and classify it as ambiguous itself. `sendEmail` receives an `AbortSignal` the worker aborts when it stops waiting; drop the request if you can, but the platform never assumes that cancelled anything (that is what `lateAcceptanceCeilingMs` is for).
- **What the platform does with each class** is in [email-outbound](email-outbound.md): no blind resend after an ambiguous outcome unless the lookup proves it safe or the provider is idempotent; otherwise the send stays UNKNOWN.

## 8. Delivery receipts and bounces (future; rules fixed in Phase 9.4)

Not implemented, but an adapter that will emit them must follow `src/server/email/delivery-events.ts`: normalize each provider event to the strict receipt shape
(`eventId`, `providerMessageId`, `sendId?`, `type` in accepted / delivered / bounced / rejected / complained, `occurredAt`, a coded `code`; no organization, no
recipient, no provider text); report only PERMANENT bounces (drop temporary deferrals); namespace and stabilize the event id exactly like a replay key; verify the webhook
with the same signature, freshness and size rules as inbound; and never label acceptance as delivery. Correlation by `providerMessageId` requires that id to be unique in
the store; zero, several or a disagreeing `sendId` quarantine the event. The outcome only ever moves up (duplicates and out-of-order events are harmless), and a
bounce outranks a delivery. Document, per provider, what its "delivered" means (usually the recipient's server accepted it) and how long it retries before bouncing.

## Checklist before connecting the first real provider

- [ ] Webhook signature algorithm and what it covers, confirmed from a real signed request.
- [ ] Replay policy numbers (`freshnessSeconds`, `retryHorizonSeconds`, `retriesResigned`) from the provider's documentation AND observed behavior.
- [ ] Replay key source field, and proof it is stable across retries and unique across notifications.
- [ ] Envelope recipient source field.
- [ ] How SPF/DKIM domains are obtained (section 4), with a payload fixture captured from the real provider.
- [ ] Authenticated fetch: endpoint, authentication, retention of the stored message, size limits, behavior for a missing/expired message.
- [ ] Inbound size limit and what the provider does with larger mail.
- [ ] Cost per received message and per fetch at the expected volume.
- [ ] Receipts: which events exist (accepted, delivered, bounced, complained), what "delivered" means exactly, how events are signed, their ids' stability across retries, how long before a bounce, and whether the provider message id is unique.
- [ ] Sending: the full evidence list in [email-provider-readiness](email-provider-readiness.md) (idempotency incl. concurrent duplicates and key retention, lookup consistency and retention, the late-acceptance ceiling, timeout classification, `Message-ID`/`In-Reply-To`/`References` preserved on the wire). Fill `sending` from the answers, not from hope; set `readiness` to `verified` only with that evidence committed.
- [ ] The shared contract suite passes against the real adapter with a harness that can sign and seed mail.
- [ ] Sandbox end-to-end test with a real domain (needs DNS access, which does not exist yet).
