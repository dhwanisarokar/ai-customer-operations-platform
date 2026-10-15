import { createLogger } from "@/lib/logger";
import { metrics } from "@/server/observability/metrics";
import { emailInboundRepository } from "@/server/repositories/email-inbound";
import { getEmailProvider } from "./index";
import { requiredLedgerRetentionDays } from "./replay-policy";

const log = createLogger("email-retention");

/**
 * Held-mail expiry. Unresolved held mail is discarded after 30 days. Until the review workflow exists nobody can
 * resolve it, and without expiry a full queue would turn legitimate mail away forever, so this is the safety
 * valve; once review exists the same function applies to anything staff never looked at.
 *
 * Floors (a shorter request is refused, so a bad job cannot cause silent loss or duplicates):
 *  - at least 14 days: staff need time to see it, and
 *  - at least the provider's required ledger retention: deleting a held row forgets its `providerMessageId`, so a
 *    late provider retry would be held a second time. The same span as the replay ledger protects against that.
 */
export const HELD_RETENTION_DAYS = 30;
export const HELD_MIN_RETENTION_DAYS = 14;

export async function expireHeldMessages(
  options: { olderThanDays?: number; now?: Date } = {},
): Promise<number> {
  const requested = options.olderThanDays ?? HELD_RETENTION_DAYS;
  if (!Number.isFinite(requested) || requested < HELD_MIN_RETENTION_DAYS) {
    throw new Error(`Held mail retention must be at least ${HELD_MIN_RETENTION_DAYS} days`);
  }
  const provider = getEmailProvider();
  const days = provider
    ? Math.max(requested, requiredLedgerRetentionDays(provider.replay))
    : requested;
  const now = options.now ?? new Date();
  const removed = await emailInboundRepository.deleteUnresolvedHeldBefore(
    new Date(now.getTime() - days * 24 * 3600_000),
  );
  if (removed > 0) {
    log.info({ removed, olderThanDays: days }, "expired held email removed");
    metrics.increment("email_held_expired_total", {}, removed);
  }
  return removed;
}
