import type { Prisma } from "@/generated/prisma/client";
import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { metrics } from "@/server/observability/metrics";
import { RateLimitError } from "@/server/rate-limit";

const log = createLogger("email-outbound-limits");

/**
 * Abuse controls for OUTBOUND email (Phase 9.6): how many emails one organization, one staff account and one recipient
 * may cause within a window. Server-side only; the client cannot influence any of it.
 *
 * Mechanism. The limits are counted from the durable ledger itself, `outbound_emails` (one row per accepted reply,
 * whatever its later fate), inside the SAME transaction that records a new reply, under a per-organization
 * transaction-scoped advisory lock. That gives, with no new infrastructure:
 *   - EXACTNESS under concurrency: two simultaneous requests cannot both take the last slot (the lock serializes the
 *     count-then-insert; tenants never wait for each other);
 *   - no bypass by idempotency key: a repeat of an earlier request is answered before this check and creates nothing; a
 *     concurrent duplicate that loses the race rolls back, and its rolled-back row is not counted; a NEW key is a new
 *     email and is counted;
 *   - no bypass by retries: a delivery retry reuses its row, so it never consumes more quota;
 *   - FAIL CLOSED: the control IS the database write. If the database cannot be reached the reply cannot be recorded
 *     either, so nothing is sent and nothing is counted in a place that could be lost (there is no in-memory counter,
 *     which would be per process and reset on every restart).
 * The cost is one short serialization of reply creation per organization, which is human-speed work.
 *
 * Windows are SLIDING (the last minute / hour / 24 hours), not fixed buckets, so a burst across a boundary cannot
 * double the allowance. Limits are configurable through the environment, always within the hard ceilings below.
 */

export const OUTBOUND_LIMIT_DEFAULTS = {
  orgPerMinute: 30,
  orgPerDay: 1000,
  userPerMinute: 20,
  recipientPerHour: 10,
} as const;

/** The most a deployment may configure; the environment schema enforces the same numbers. */
export const OUTBOUND_LIMIT_CEILINGS = {
  orgPerMinute: 600,
  orgPerDay: 100_000,
  userPerMinute: 120,
  recipientPerHour: 100,
} as const;

export type OutboundLimits = { [K in keyof typeof OUTBOUND_LIMIT_DEFAULTS]: number };

export function getOutboundLimits(): OutboundLimits {
  const env = getServerEnv();
  return {
    orgPerMinute: env.EMAIL_OUTBOUND_ORG_PER_MINUTE ?? OUTBOUND_LIMIT_DEFAULTS.orgPerMinute,
    orgPerDay: env.EMAIL_OUTBOUND_ORG_PER_DAY ?? OUTBOUND_LIMIT_DEFAULTS.orgPerDay,
    userPerMinute: env.EMAIL_OUTBOUND_USER_PER_MINUTE ?? OUTBOUND_LIMIT_DEFAULTS.userPerMinute,
    recipientPerHour:
      env.EMAIL_OUTBOUND_RECIPIENT_PER_HOUR ?? OUTBOUND_LIMIT_DEFAULTS.recipientPerHour,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type LimitReason = "org_day" | "org_minute" | "user_minute" | "recipient_hour";

/**
 * Refuses (429, generic message, Retry-After) when recording one more email for `organizationId` by `userId` to
 * `toAddress` would exceed a limit. MUST run inside the transaction that records the email, before anything is
 * written: the advisory lock it takes is released at commit or rollback.
 *
 * Nothing about the tenant, the recipient or which limit tripped reaches the client; the reason goes to a metric and
 * a log line carrying only the organization id (never an address, a subject or text).
 */
export async function enforceOutboundLimits(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; userId: string; toAddress: string },
  now: Date = new Date(),
  limits: OutboundLimits = getOutboundLimits(),
): Promise<void> {
  const { organizationId, userId, toAddress } = input;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`email-outbound-limits:${organizationId}`}, 0))`;

  const since = (ms: number) => ({ gt: new Date(now.getTime() - ms) });
  const checks: {
    reason: LimitReason;
    limit: number;
    retryAfterSeconds: number;
    count: () => Promise<number>;
  }[] = [
    {
      reason: "org_day",
      limit: limits.orgPerDay,
      retryAfterSeconds: 3600,
      count: () => tx.outboundEmail.count({ where: { organizationId, createdAt: since(DAY) } }),
    },
    {
      reason: "org_minute",
      limit: limits.orgPerMinute,
      retryAfterSeconds: 60,
      count: () => tx.outboundEmail.count({ where: { organizationId, createdAt: since(MINUTE) } }),
    },
    {
      reason: "user_minute",
      limit: limits.userPerMinute,
      retryAfterSeconds: 60,
      count: () =>
        tx.outboundEmail.count({
          where: { organizationId, createdAt: since(MINUTE), message: { senderUserId: userId } },
        }),
    },
    {
      reason: "recipient_hour",
      limit: limits.recipientPerHour,
      retryAfterSeconds: 900,
      count: () =>
        tx.outboundEmail.count({
          where: { organizationId, toAddress, createdAt: since(HOUR) },
        }),
    },
  ];

  for (const check of checks) {
    if ((await check.count()) < check.limit) continue;
    metrics.increment("email_outbound_rejected_total", { reason: check.reason });
    const fields = { organizationId, reason: check.reason };
    if (check.reason === "org_day") log.warn(fields, "outbound email daily quota exhausted");
    else log.info(fields, "outbound email rate limit reached");
    throw new RateLimitError(check.retryAfterSeconds);
  }
}
