import { createLogger } from "@/lib/logger";
import { metrics } from "@/server/observability/metrics";
import { emailInboundRepository } from "@/server/repositories/email-inbound";
import { emailAvailable, getEmailProvider } from "./index";
import { ingestInboundEmail, type InboundResult } from "./inbound";
import { requiredLedgerRetentionDays } from "./replay-policy";

const log = createLogger("email-inbound");

/** The notification is a pointer, not the message: a body larger than this is not a real notification. */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

export type WebhookResponse = {
  status: number;
  body: { status: string; results?: string[] };
};

/**
 * Handles one provider notification end to end, in this order:
 *
 *  1. the provider adapter authenticates the request (signature, freshness); anything else is rejected
 *     before any state is read or written. There is no bypass: the production provider is the only one
 *     that can be configured in production, and a request nobody signed never gets past here;
 *  2. a replayed notification (its single-use key was already consumed) is acknowledged without work;
 *  3. the message is fetched over the provider's AUTHENTICATED API (never trusted from the webhook body);
 *  4. it is ingested (see `ingestInboundEmail`);
 *  5. the key is recorded, so the same notification is never processed twice.
 *
 * HTTP semantics (what the provider does next): 2xx = done, do not retry (including duplicates, held and
 * ignored mail); 4xx = rejected, will not succeed on retry; 5xx = temporary, retry.
 */
export async function handleInboundWebhook(request: {
  headers: Record<string, string>;
  rawBody: string;
  now?: Date;
}): Promise<WebhookResponse> {
  const provider = getEmailProvider();
  // No provider or no platform domain configured: the endpoint does not exist for this deployment. (Without
  // the domain the loop protection could not work either, so nothing is processed.)
  if (!provider || !emailAvailable()) {
    metrics.increment("email_webhook_rejected_total", { reason: "not_configured" });
    return { status: 404, body: { status: "not_found" } };
  }

  if (Buffer.byteLength(request.rawBody, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
    metrics.increment("email_webhook_rejected_total", { reason: "too_large" });
    return { status: 413, body: { status: "too_large" } };
  }

  const verified = provider.verifyWebhook(request);
  if (!verified.ok) {
    log.warn({ reason: verified.reason }, "email webhook rejected");
    metrics.increment("email_webhook_rejected_total", { reason: verified.reason });
    return verified.reason === "malformed"
      ? { status: 400, body: { status: "malformed" } }
      : { status: 401, body: { status: "unauthorized" } };
  }

  // Delivery receipts belong to the outbound stage (9.3); nothing sends email yet, so there is nothing to update.
  if (verified.kind === "delivery") {
    return { status: 200, body: { status: "ignored" } };
  }

  if (await emailInboundRepository.hasWebhookEvent(verified.replayKey)) {
    return { status: 200, body: { status: "duplicate" } };
  }

  const email = await provider.fetchInboundEmail(verified.providerRef);
  if (!email) {
    // Not retrievable (yet, or any more). Ask for a retry; a message that never appears stops being retried
    // by the provider's own limits.
    log.warn("inbound email could not be fetched");
    metrics.increment("email_fetch_unavailable_total");
    return { status: 503, body: { status: "unavailable" } };
  }

  const results = await ingestInboundEmail(email);
  const summary = summarize(results);
  await emailInboundRepository.recordWebhookEvent(
    verified.replayKey,
    summary.outcome,
    summary.reason,
  );
  return {
    status: 200,
    body: { status: summary.outcome.toLowerCase(), results: results.map((r) => r.status) },
  };
}

function summarize(results: InboundResult[]) {
  if (results.some((r) => r.status === "processed")) {
    return { outcome: "PROCESSED" as const, reason: null };
  }
  if (results.some((r) => r.status === "held")) return { outcome: "HELD" as const, reason: null };
  if (results.every((r) => r.status === "duplicate")) {
    return { outcome: "DUPLICATE" as const, reason: null };
  }
  const ignored = results.find((r) => r.status === "ignored");
  return {
    outcome: "IGNORED" as const,
    reason: ignored?.status === "ignored" ? ignored.reason : null,
  };
}

/**
 * Replay-ledger retention. An entry only has to outlive the window in which the same notification could be
 * accepted again: the adapter's freshness window (minutes) plus the provider's retry horizon (hours to a few
 * days). After that a replay is refused as stale, and even a replay that got through would be deduplicated by
 * the stored `providerMessageId`. The default keeps 30 days, and a shorter retention than the floor is refused
 * so a misconfigured job can never weaken replay protection.
 */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;
export const WEBHOOK_EVENT_MIN_RETENTION_DAYS = 7;

/** Deletes expired ledger entries. Meant for a scheduled job (the platform has no scheduler yet). */
export async function purgeExpiredWebhookEvents(
  options: { olderThanDays?: number; now?: Date } = {},
): Promise<number> {
  const requested = options.olderThanDays ?? WEBHOOK_EVENT_RETENTION_DAYS;
  if (!Number.isFinite(requested) || requested < WEBHOOK_EVENT_MIN_RETENTION_DAYS) {
    throw new Error(
      `Replay ledger retention must be at least ${WEBHOOK_EVENT_MIN_RETENTION_DAYS} days`,
    );
  }
  // The configured provider's own replay facts raise the floor: the ledger must outlive twice the longest
  // span in which one of its notifications could be presented again (freshness window + retry horizon).
  const provider = getEmailProvider();
  const days = provider
    ? Math.max(requested, requiredLedgerRetentionDays(provider.replay))
    : requested;
  const now = options.now ?? new Date();
  const removed = await emailInboundRepository.deleteWebhookEventsBefore(
    new Date(now.getTime() - days * 24 * 3600_000),
  );
  if (removed > 0) log.info({ removed }, "expired email webhook events removed");
  return removed;
}

/**
 * Reads a request body but gives up as soon as it exceeds `maxBytes`, WITHOUT buffering the rest: an
 * unauthenticated caller can send a chunked body with no (or a false) Content-Length, so the limit has to be
 * enforced on the bytes actually read. Returns null when the body is too large.
 */
export async function readBodyWithLimit(
  request: Request,
  maxBytes: number,
): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
