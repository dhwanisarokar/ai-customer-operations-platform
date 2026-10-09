import IORedis from "ioredis";
import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { AppError } from "@/server/errors";
import { whenRedisReady } from "@/server/redis-ready";

const log = createLogger("rate-limit");

export type RateLimit = { limit: number; windowSeconds: number };
export type RateLimitResult = { allowed: boolean; remaining: number; retryAfterSeconds: number };

export interface RateLimiter {
  hit(key: string, rule: RateLimit): Promise<RateLimitResult>;
}

/** Fixed-window counter in this process. Exact for one instance; used by tests and as the fallback. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, rule: RateLimit): Promise<RateLimitResult> {
    const now = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + rule.windowSeconds * 1000 };
      this.windows.set(key, window);
    }
    window.count++;
    return {
      allowed: window.count <= rule.limit,
      remaining: Math.max(0, rule.limit - window.count),
      retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
    };
  }
}

/** Shared across instances through Redis. Falls back to the in-process limiter if Redis fails. */
export class RedisRateLimiter implements RateLimiter {
  private readonly redis: IORedis;
  constructor(
    url: string,
    private readonly fallback: RateLimiter = new MemoryRateLimiter(),
  ) {
    this.redis = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    this.redis.on("error", () => undefined);
  }

  async hit(key: string, rule: RateLimit): Promise<RateLimitResult> {
    try {
      await whenRedisReady(this.redis);
      const redisKey = `rl:${key}`;
      const count = await this.redis.incr(redisKey);
      if (count === 1) await this.redis.expire(redisKey, rule.windowSeconds);
      const ttl = await this.redis.ttl(redisKey);
      return {
        allowed: count <= rule.limit,
        remaining: Math.max(0, rule.limit - count),
        retryAfterSeconds: Math.max(1, ttl),
      };
    } catch (error) {
      log.warn(
        { err: error instanceof Error ? error.name : "unknown" },
        "redis rate limit failed; using memory",
      );
      return this.fallback.hit(key, rule);
    }
  }
}

let limiter: RateLimiter | undefined;

export function getRateLimiter(): RateLimiter {
  if (!limiter) {
    const env = getServerEnv();
    limiter =
      env.REDIS_URL && env.REALTIME_DRIVER !== "memory" && env.AUTOMATION_QUEUE_DRIVER !== "memory"
        ? new RedisRateLimiter(env.REDIS_URL)
        : new MemoryRateLimiter();
  }
  return limiter;
}

/** Test hook. */
export function setRateLimiterForTesting(next: RateLimiter | undefined) {
  limiter = next;
}

export class RateLimitError extends AppError {
  readonly headers: Record<string, string>;
  constructor(retryAfterSeconds: number) {
    super(429, "rate_limited", "Too many requests. Please slow down and try again shortly.");
    this.headers = { "retry-after": String(retryAfterSeconds) };
  }
}

/** Throws a 429 (with Retry-After) when `key` exceeded `rule`. */
export async function enforceRateLimit(key: string, rule: RateLimit): Promise<void> {
  const result = await getRateLimiter().hit(key, rule);
  if (!result.allowed) throw new RateLimitError(result.retryAfterSeconds);
}

/** Best-effort client address behind a proxy (the first X-Forwarded-For entry). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip") || "unknown";
}
