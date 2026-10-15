/**
 * What staff are allowed to see of an outbound email's delivery, derived from the persisted `outbound_emails` row.
 *
 * Deliberately NOT exposed: the provider's message id, raw error codes (they are internal and can reveal how the provider
 * is set up), attempt leases, addresses (the conversation already shows the customer), Message-IDs. Staff get a small,
 * stable vocabulary:
 *
 *   queued    recorded, nobody has picked it up yet
 *   sending   a worker is delivering it right now
 *   accepted  the mail PROVIDER accepted it. This is NOT proof of delivery: the provider may still bounce it or the
 *             recipient's server may refuse it, and this phase has no delivery receipts
 *   retrying  a temporary problem; a retry is scheduled (the time is shown)
 *   failed    it will not be sent (a definite refusal, retries used up, or a pre-send check failed)
 *   unknown   the provider MAY have accepted it but nobody can tell (a lost response or a crashed worker, with no safe
 *             way to find out): it is neither success nor failure and must NOT be resent without checking
 */
export type DeliveryState = "queued" | "sending" | "accepted" | "retrying" | "failed" | "unknown";

/** A coarse, human-safe reason for a failed send. */
export type DeliveryFailure =
  | "rejected"
  | "retries_exhausted"
  | "sender_unavailable"
  | "message_missing"
  // Resolved from UNKNOWN: the provider's own lookup has no record of it / an operator attested it was not sent.
  // Either way it was NOT sent and nobody should assume otherwise; neither means "the provider refused it".
  | "provider_no_record"
  | "operator_confirmed_not_sent";

export type MessageDeliveryDto = {
  state: DeliveryState;
  /** `retrying` only: when the next attempt is due. */
  retryAt: Date | null;
  /** `accepted` only: when the provider accepted it (NOT when it was delivered). */
  acceptedAt: Date | null;
  failedAt: Date | null;
  /** `failed` only. */
  failure: DeliveryFailure | null;
};

type Row = {
  status: "PENDING" | "PROCESSING" | "SENT" | "RETRY_SCHEDULED" | "FAILED" | "UNKNOWN";
  nextAttemptAt: Date;
  sentAt: Date | null;
  failedAt: Date | null;
  finalReason: string | null;
};

const STATE: Record<Row["status"], DeliveryState> = {
  PENDING: "queued",
  PROCESSING: "sending",
  SENT: "accepted",
  RETRY_SCHEDULED: "retrying",
  FAILED: "failed",
  UNKNOWN: "unknown",
};

function failureOf(reason: string | null): DeliveryFailure {
  switch (reason) {
    case "retries_exhausted":
    case "sender_unavailable":
    case "message_missing":
      return reason;
    case "provider_has_no_record":
      return "provider_no_record";
    case "operator_confirmed_not_sent":
      return "operator_confirmed_not_sent";
    default:
      // "permanent" and anything unforeseen: a definite refusal, without provider detail.
      return "rejected";
  }
}

export function toDeliveryDto(row: Row): MessageDeliveryDto {
  const state = STATE[row.status];
  return {
    state,
    retryAt: state === "retrying" ? row.nextAttemptAt : null,
    acceptedAt: state === "accepted" ? row.sentAt : null,
    failedAt: state === "failed" ? row.failedAt : null,
    failure: state === "failed" ? failureOf(row.finalReason) : null,
  };
}

/** States in which the status will still change by itself: the UI keeps refreshing while one is shown. */
export function isSettledDelivery(state: DeliveryState): boolean {
  return state === "accepted" || state === "failed" || state === "unknown";
}
