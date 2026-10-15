# 015 - Email channel behind a narrow provider adapter

Status: accepted for 9.1 and 9.2; **provider: Amazon SES preferred candidate, final choice pending**

## Context

Phase 9 adds email as an Inbox channel. Email brings new risks: unauthenticated inbound requests, forged
senders, header injection, loops, duplicates, and a third-party provider whose guarantees differ. The
platform has per-organization data but no per-organization secrets, and a queue with no scheduler.

## Decision

- Email is a `ConversationChannel` value (`EMAIL`) on the existing domain, not a parallel one.
- Organizations get platform-controlled addresses (`<name>@<platform domain>`). The address is the only
  routing key and is globally unique; the organization is always resolved from trusted server-side
  configuration, never from a request field.
- All provider specifics sit behind `EmailProvider` (`ensureAddress`, `verifyWebhook`, `fetchInboundEmail`,
  `sendEmail`) with a `FakeEmailProvider` and a shared contract test suite. Conversation code never imports a
  provider.
- **Content integrity comes from the provider's authenticated API, not the webhook body.** `verifyWebhook`
  yields a signed reference and a single-use replay key; the message is then fetched and parsed into a bounded
  shape. This holds for providers whose signature does not cover the body.
- 9.1 adds only `email_settings` and the enum value. Message, webhook-event and outbox tables are added with
  the stages that use them, so the schema follows real requirements.
- No autonomous AI email replies and no automation-triggered customer emails (v1).

## Provider: SES preferred, not yet implemented

Mailgun was the provisional choice. Its documented signature (`HMAC(timestamp + token)`) does not cover the
body of form-encoded inbound posts, replay protection is left to the receiver, and the JSON-body variant is
documented inconsistently. Options and trade-offs:

1. **Mailgun with notify + authenticated fetch** (compatible with the contract). Pros: mature inbound routing,
   per-domain DKIM, no private beta. Cons: relies on the retrieval API and its retention; JSON-body signing is
   unverified; two round trips per message.
2. **Resend** once inbound is generally available. Pros: full-body Svix signatures, idempotency keys on send.
   Cons: inbound is private beta; header control for threading unconfirmed.
3. **Amazon SES** (inbound via SNS/S3). Pros: signed SNS messages, durable storage of the raw message.
   Cons: more infrastructure to run and secure.

No adapter is written until this is decided and the chosen provider's behavior is verified against a real
account.

## Consequences

- 9.1 is provider-independent and fully testable with the fake provider.
- A weaker-signature provider is safe by construction, at the cost of an extra fetch.
- The channel is off for every organization until an admin verifies and enables an address, and cannot be
  enabled at all unless the deployment configures a provider and a domain.

## Amendment (Phase 9.2): inbound processing

- The organization is chosen by the **envelope recipient** (`deliveredTo`) looked up in enabled, verified
  support addresses; `To`/`Cc` are metadata. The adapter contract gained `deliveredTo`, and "pass" for
  SPF/DKIM must mean aligned with the From domain.
- **Fail closed on identity:** a sender with neither SPF nor DKIM passing is held for review and is never
  matched to or turned into a customer. Archived customers, ambiguous threads and threads quoted by a
  different sender are held too. Nothing is attached by guesswork.
- Threading uses RFC headers only, inside the organization, `In-Reply-To` before `References`; never the subject.
- Ingestion is one transaction (customer, conversation, message, email record) with events emitted after
  commit. This required splitting `persistMessage` and `createConversationCore` into transaction-joinable
  functions (`persistMessageInTransaction`, `createConversationInTransaction`) plus `announce*` functions; the
  public functions behave exactly as before.
- Replay and duplicate protection: a content-free ledger of consumed notification keys, plus a unique
  `providerMessageId` per organization. Abuse is bounded per organization, per sender and in the review queue.
- Messages are never trusted from the webhook body (fetched over the authenticated API), as decided before.
- Still open for SES specifically (to confirm before an adapter): how an SNS/S3 notification maps to
  `verifyWebhook` (SNS message signature verification, topic ARN pinning), how SPF/DKIM/DMARC verdicts and the
  envelope recipients are read from the receipt, the S3 object retention and size limit for `fetchInboundEmail`,
  and the cost of the receipt rule set, SNS and S3 per organization-addressed message.
