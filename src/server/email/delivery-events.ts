import { z } from "zod";

/**
 * THE PROVIDER-NEUTRAL CONTRACT FOR DELIVERY RECEIPTS AND BOUNCES (designed in Phase 9.4; NOT wired to anything yet).
 *
 * No provider webhook, no persistence and no state change exist for these events today (inbound `delivery`
 * notifications are acknowledged and ignored). This file fixes the RULES a future implementation must follow, as pure,
 * tested functions, so that the first real adapter cannot get ordering, duplicates or correlation wrong.
 *
 * Two facts are kept apart, always:
 *   - `outbound_emails.status = SENT` means the PROVIDER ACCEPTED the email. It is not delivery.
 *   - a delivery OUTCOME is what later receipts say happened. Only a `delivered` receipt is delivery evidence, and only
 *     as authoritative as that provider's own definition (usually "the recipient's mail server accepted it"; it still
 *     says nothing about the inbox, the spam folder or a human reading it). The fake provider verifies none of this.
 */

export const RECEIPT_TYPES = [
  "accepted",
  "delivered",
  "bounced",
  "rejected",
  "complained",
] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/**
 * One receipt, as an adapter normalizes it after verifying the provider's webhook (see the adapter contract). Strict:
 * there is NO organization field. The organization is whatever the correlated send belongs to, never what a payload says.
 *
 *  - `eventId`: the provider's event id, namespaced by the adapter like a replay key
 *    (`<provider>:<account>:<event id>`, stable across the provider's retries). It is the idempotency key of processing.
 *  - `providerMessageId`: the id the provider returned when it accepted the send; the primary correlation key.
 *  - `sendId`: our send id (the idempotency key) when the provider echoes it; if present it MUST agree.
 *  - `bounced` means a PERMANENT bounce. Temporary deferrals ("will keep trying") are not events: an adapter drops them.
 *  - `code`: a short machine code, never provider text.
 */
export const deliveryReceiptSchema = z
  .object({
    eventId: z
      .string()
      .min(1)
      .max(300)
      .refine(
        (value) => !new RegExp("[\\s\\u0000-\\u001f\\u007f]").test(value),
        "whitespace or control characters",
      ),
    providerMessageId: z.string().min(1).max(256),
    sendId: z.uuid().nullable().default(null),
    type: z.enum(RECEIPT_TYPES),
    occurredAt: z.date(),
    code: z
      .string()
      .regex(/^[a-z0-9_]{1,64}$/)
      .nullable()
      .default(null),
  })
  .strict();
export type DeliveryReceipt = z.output<typeof deliveryReceiptSchema>;

// ---- the outcome model --------------------------------------------------------------------------------------

/**
 * What the receipts, taken together, say. `level` only ever goes UP, which is what makes duplicate and out-of-order
 * receipts harmless:
 *
 *   none < accepted < delivered < negative
 *
 * "negative" (a permanent bounce, or the provider rejecting it after the fact) outranks "delivered" on purpose: a bounce
 * can arrive AFTER a delivery receipt (asynchronous bounces are real), and a late "delivered" must never undo a bounce.
 * A complaint is a separate fact (the recipient reported it as spam) that also proves the email was delivered.
 */
export type DeliveryOutcome = {
  level: "none" | "accepted" | "delivered" | "negative";
  /** Only for `negative`. When both kinds were reported the fixed precedence below decides, never arrival order. */
  negative: "bounced" | "rejected" | null;
  complained: boolean;
};

export const NO_OUTCOME: DeliveryOutcome = { level: "none", negative: null, complained: false };

const RANK: Record<DeliveryOutcome["level"], number> = {
  none: 0,
  accepted: 1,
  delivered: 2,
  negative: 3,
};
const LEVEL_OF: Record<ReceiptType, DeliveryOutcome["level"]> = {
  accepted: "accepted",
  delivered: "delivered",
  bounced: "negative",
  rejected: "negative",
  complained: "delivered",
};

/**
 * Folds one receipt into the outcome. Pure, IDEMPOTENT (applying the same receipt twice changes nothing), COMMUTATIVE
 * (any arrival order gives the same result) and MONOTONE (the outcome never gets weaker). So a duplicate cannot produce a
 * second transition, and a stale or out-of-order receipt cannot overwrite newer authoritative state. The receipt's own
 * timestamp is deliberately NOT used to order events: clocks and delivery order are not trustworthy evidence.
 */
export function reduceOutcome(
  current: DeliveryOutcome,
  receipt: Pick<DeliveryReceipt, "type">,
): { next: DeliveryOutcome; changed: boolean } {
  const incomingLevel = LEVEL_OF[receipt.type];
  const level = RANK[incomingLevel] > RANK[current.level] ? incomingLevel : current.level;

  let negative = current.negative;
  if (receipt.type === "bounced" || receipt.type === "rejected") {
    // "bounced" beats "rejected": a fixed precedence keeps the result independent of arrival order.
    negative =
      current.negative === "bounced" || receipt.type === "bounced" ? "bounced" : "rejected";
  }
  const complained = current.complained || receipt.type === "complained";
  const next: DeliveryOutcome = {
    level,
    negative: level === "negative" ? negative : null,
    complained,
  };
  const changed =
    next.level !== current.level ||
    next.negative !== current.negative ||
    next.complained !== current.complained;
  return { next: changed ? next : current, changed };
}

export function foldReceipts(receipts: Pick<DeliveryReceipt, "type">[]): DeliveryOutcome {
  return receipts.reduce((state, receipt) => reduceOutcome(state, receipt).next, NO_OUTCOME);
}

/**
 * The ONLY thing allowed to say "delivered": a provider-confirmed delivery receipt (or a complaint, which proves it).
 * It is a function of the outcome, never of `outbound_emails.status`: SENT is acceptance.
 */
export function isConfirmedDelivery(outcome: DeliveryOutcome): boolean {
  return outcome.level === "delivered";
}

/** Plain wording for staff, with the claim each state actually supports. */
export function describeOutcome(outcome: DeliveryOutcome): string | null {
  switch (outcome.level) {
    case "none":
      return null;
    case "accepted":
      return "Accepted by the mail provider. Delivery is not confirmed.";
    case "delivered":
      return outcome.complained
        ? "The provider reports it was delivered, and the recipient reported it as spam."
        : "The provider reports it was delivered to the recipient's mail server.";
    case "negative":
      return outcome.negative === "rejected"
        ? "The mail provider rejected it after accepting it. The customer did not receive it."
        : "It bounced. The customer did not receive it.";
  }
}

// ---- tenant-safe correlation ---------------------------------------------------------------------------------

export type SendCandidate = {
  id: string;
  organizationId: string;
  providerMessageId: string | null;
};

export type Correlation =
  { ok: true; send: SendCandidate } | { ok: false; reason: "unmatched" | "ambiguous" | "mismatch" };

/**
 * Which send a receipt is about. `candidates` are the sends the store found for the receipt's `providerMessageId` (a
 * lookup by that id alone, across the platform's single provider account, which is why the id must be UNIQUE in the
 * store). The receipt is accepted only when EXACTLY ONE send matches and, if the provider echoed our send id, it agrees.
 * Anything else is quarantined (counted, never applied): a receipt can never create a send, pick an organization, or
 * touch a send it does not unambiguously identify. The organization used afterwards is the matched send's own.
 */
export function correlateReceipt(
  receipt: Pick<DeliveryReceipt, "providerMessageId" | "sendId">,
  candidates: SendCandidate[],
): Correlation {
  const matches = candidates.filter((c) => c.providerMessageId === receipt.providerMessageId);
  if (matches.length === 0) return { ok: false, reason: "unmatched" };
  if (matches.length > 1) return { ok: false, reason: "ambiguous" };
  if (receipt.sendId && receipt.sendId !== matches[0].id) return { ok: false, reason: "mismatch" };
  return { ok: true, send: matches[0] };
}
