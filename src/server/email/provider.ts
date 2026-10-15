import { z } from "zod";
import { MAX_ADDRESS_LENGTH } from "./address";
import type { ReplayPolicy } from "./replay-policy";
import { senderAuthSchema } from "./sender-auth";

/**
 * The narrow boundary between the platform and an email provider (Mailgun, Resend, ...). Conversation
 * logic never imports a provider; it only sees these types, so another provider can be added without
 * touching it. Provider-specific parsing, signing and HTTP live in one adapter file per provider.
 *
 * Design principle: INTEGRITY OF CONTENT COMES FROM THE PROVIDER'S AUTHENTICATED API, NOT FROM THE WEBHOOK.
 * An inbound webhook is only a (verified) notification that carries a reference. The message itself is
 * fetched with `fetchInboundEmail(ref)` over the provider's authenticated API. This holds even for
 * providers whose webhook signature does not cover the request body.
 */

// ---- inbound -----------------------------------------------------------------------------------------

export const MAX_INBOUND_TEXT_CHARS = 100_000;
export const MAX_INBOUND_SUBJECT_CHARS = 500;
export const MAX_INBOUND_RECIPIENTS = 50;
export const MAX_INBOUND_ATTACHMENTS = 50;
export const MAX_INBOUND_REFERENCES = 50;

const address = z.string().min(3).max(MAX_ADDRESS_LENGTH);

/**
 * An inbound email in the platform's own shape. Everything is bounded: a provider (or a hostile sender
 * behind it) cannot make the platform store unbounded text. Plain text only in v1: HTML is reduced to text
 * by the adapter and never rendered; attachments are metadata only and are never downloaded or served.
 */
export const normalizedInboundEmailSchema = z.object({
  /** The provider's id for this message: the idempotency key of ingestion. */
  providerMessageId: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => !new RegExp("[\\u0000-\\u001f\\u007f]").test(value), "control characters"),
  /** RFC 5322 Message-ID header (with angle brackets), when present. */
  messageId: z.string().min(3).max(512).nullable(),
  inReplyTo: z.string().min(3).max(512).nullable(),
  references: z.array(z.string().min(3).max(512)).max(MAX_INBOUND_REFERENCES),
  from: address,
  fromName: z.string().max(200).nullable(),
  /**
   * The addresses the provider actually accepted this message FOR (the SMTP envelope recipients). This, and
   * only this, decides which organization receives the email: the To/Cc headers are chosen by the sender and
   * are recorded for the timeline but never used for routing.
   */
  deliveredTo: z.array(address).min(1).max(MAX_INBOUND_RECIPIENTS),
  to: z.array(address).min(1).max(MAX_INBOUND_RECIPIENTS),
  /** Recorded as metadata only; replies are never sent to CC recipients in v1. */
  cc: z.array(address).max(MAX_INBOUND_RECIPIENTS),
  subject: z.string().max(MAX_INBOUND_SUBJECT_CHARS),
  text: z.string().max(MAX_INBOUND_TEXT_CHARS),
  receivedAt: z.date(),
  /** Facts for loop and spam control (Auto-Submitted, Precedence, List-Id, bounce notices...), computed by the adapter. */
  automated: z.boolean(),
  /**
   * SPF and DKIM results WITH the domains they passed for (see `sender-auth.ts` for the full contract). The
   * adapter reports facts; the platform decides whether they authenticate the From address (alignment).
   */
  senderAuth: senderAuthSchema,
  attachments: z
    .array(
      z.object({
        filename: z.string().max(255),
        contentType: z.string().max(200),
        size: z.number().int().min(0),
      }),
    )
    .max(MAX_INBOUND_ATTACHMENTS),
});
export type NormalizedInboundEmail = z.infer<typeof normalizedInboundEmailSchema>;

/** The result of verifying a webhook request. `replayKey` must be remembered by the caller (single use). */
export type VerifiedWebhook =
  | { ok: true; kind: "inbound"; providerRef: string; replayKey: string }
  | { ok: true; kind: "delivery"; event: DeliveryEvent; replayKey: string }
  | { ok: false; reason: "bad_signature" | "stale" | "malformed" };

// ---- delivery events ---------------------------------------------------------------------------------

export type DeliveryEvent = {
  /** The provider's id of the event: idempotency key of event handling. */
  eventId: string;
  /** The provider's id of the OUTBOUND message the event is about. */
  providerMessageId: string;
  type: "delivered" | "bounced" | "complained" | "failed";
  /** Short machine code, never provider text. */
  code: string | null;
  occurredAt: Date;
};

// ---- outbound ----------------------------------------------------------------------------------------

export type OutboundEmail = {
  from: { address: string; name: string };
  to: string;
  subject: string;
  text: string;
  /** Our own, deterministic RFC Message-ID (see the outbox): a duplicate send keeps the same id. */
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  /** One key per outbox row; a provider that supports it uses it to refuse duplicate sends. */
  idempotencyKey: string;
};

/**
 * The outcome of ONE send attempt, in four classes:
 *  - success: the provider accepted the message (`providerMessageId`);
 *  - permanent failure (`retryable: false`): a definite refusal; never retried;
 *  - retryable failure (`retryable: true`): a definite "not accepted, try again later" (rate limit, 5xx before
 *    acceptance, connection refused);
 *  - AMBIGUOUS (`ambiguous: true`): the provider MAY have accepted the message but the answer was lost (timeout
 *    after the request was sent, connection reset while reading the response). Unlike a known failure this must
 *    never be retried blindly: see `SendingCapabilities` and `outbound-state.ts`.
 * `code` is a short machine code (`^[a-z0-9_]{1,64}$`), never provider text. Adapters never throw for provider errors.
 */
export type SendResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; ambiguous?: false; retryable: boolean; code: string }
  | { ok: false; ambiguous: true; code: string };

/**
 * What a provider PROMISES about duplicate sends and about being asked afterwards. Every field is a DECLARATION by the
 * adapter author until `ProviderReadiness` says it was verified; `provider-policy.ts` rejects declarations that are
 * internally inconsistent or too weak to build a safe retry on. Durations are milliseconds; `null` = unknown, and
 * unknown is always treated as "no guarantee".
 *
 * Nothing here may be copied from the fake provider or from a provider's marketing page: see
 * docs/email-provider-readiness.md for the evidence a value needs.
 */
export type SendingCapabilities = {
  /**
   * The provider refuses to deliver a second time for the same `idempotencyKey` and answers a repeat with the
   * original result, INCLUDING a repeat that arrives while the first request is still in flight.
   */
  idempotentByKey: boolean;
  /** How long the provider remembers a key (it must outlast the platform's whole retry horizon). */
  keyRetentionMs: number | null;
  /** `findSendByKey` exists and its answers mean what `lookupConsistency` says. */
  lookupByKey: boolean;
  /**
   *  - "strong": once the provider accepted a send, the lookup finds it at once ("not_found" is final);
   *  - "eventual": the lookup may miss an accepted send for up to `lookupSettleMs`;
   *  - "none": the lookup says nothing reliable (it is then treated as no lookup at all).
   */
  lookupConsistency: "none" | "eventual" | "strong";
  /** Eventual lookups: the longest an ACCEPTED send can stay invisible to the lookup. */
  lookupSettleMs: number | null;
  /** How long after a send the lookup still remembers it. Past this, "not_found" proves nothing. */
  lookupRetentionMs: number | null;
  /**
   * The longest, counted from the moment our request is sent, that the provider may STILL accept it, even though we
   * stopped waiting (a timed-out request is not cancelled: aborting our socket does not un-send what the provider
   * already read). Platform code never assumes a cancellation worked; it waits this long instead.
   */
  lateAcceptanceCeilingMs: number | null;
};

/** Declared capabilities are not production readiness. `verified` needs a pointer to the evidence (a document). */
export type ProviderReadiness =
  | { status: "fake"; evidence: null }
  | { status: "declared"; evidence: string | null }
  | { status: "verified"; evidence: string };

export type SendLookup =
  | { status: "found"; providerMessageId: string }
  | { status: "not_found" }
  | { status: "unavailable" };

export type AddressCheck = { ok: true } | { ok: false; code: string };

export interface EmailProvider {
  readonly name: string;

  /** The adapter's replay facts (freshness window, the provider's retry horizon). See `replay-policy.ts`. */
  readonly replay: ReplayPolicy;

  /** What this provider promises about duplicate sends; drives the ambiguous-outcome policy. */
  readonly sending: SendingCapabilities;

  /** Whether those promises were verified against the real provider (see docs/email-provider-readiness.md). */
  readonly readiness: ProviderReadiness;

  /**
   * Makes sure mail for `address` (on the platform domain) is received by the platform and can be sent
   * from. Idempotent. Used to verify an organization's address; never involves a secret of the organization.
   */
  ensureAddress(address: string): Promise<AddressCheck>;

  /**
   * Verifies that a webhook request really comes from the provider (raw body and headers, exactly as
   * received) and is recent. It never trusts any organization, recipient or sender field in the payload.
   */
  verifyWebhook(input: {
    headers: Record<string, string>;
    rawBody: string;
    now?: Date;
  }): VerifiedWebhook;

  /** Fetches the authoritative message for a reference returned by `verifyWebhook`. */
  fetchInboundEmail(providerRef: string): Promise<NormalizedInboundEmail | null>;

  /**
   * Sends one email. Must not throw for provider errors: it classifies them (see `SendResult`). The platform aborts
   * `signal` when it stops waiting; an adapter should then drop the request, but the platform NEVER treats an abort as
   * proof that nothing was sent (see `lateAcceptanceCeilingMs`).
   */
  sendEmail(message: OutboundEmail, options?: { signal?: AbortSignal }): Promise<SendResult>;

  /** Only when `sending.lookupByKey`: did the provider accept a send with this idempotency key? */
  findSendByKey?(idempotencyKey: string): Promise<SendLookup>;
}
