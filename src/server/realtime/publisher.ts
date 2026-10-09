import { randomUUID } from "node:crypto";
import IORedis from "ioredis";
import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { whenRedisReady } from "@/server/redis-ready";
import type { RealtimeEvent } from "./events";

const log = createLogger("realtime");

type Listener = (event: RealtimeEvent) => void;
type Envelope = { origin: string; channel: string; event: RealtimeEvent };

const REDIS_TOPIC = "realtime:events";

/**
 * In-process fan-out plus (optionally) Redis pub/sub between instances.
 *
 * - Publishing ALWAYS delivers to this process's subscribers, so a single instance works without
 *   Redis (development, tests).
 * - When Redis is configured the event is also published there; other instances deliver it to their
 *   own subscribers. Messages from this instance are ignored on the way back (no duplicates).
 * - Publishing is best effort and never throws: realtime is a delivery mechanism, the database is the
 *   source of truth, and clients reconcile by refetching on (re)connect.
 */
class RealtimeHub {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly origin = randomUUID();
  private publisher: IORedis | undefined;
  private subscriber: IORedis | undefined;
  private subscribing = false;

  subscribe(channel: string, listener: Listener): () => void {
    let set = this.listeners.get(channel);
    if (!set) this.listeners.set(channel, (set = new Set()));
    set.add(listener);
    this.ensureRedisSubscriber();
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(channel);
    };
  }

  subscriberCount(channel?: string): number {
    if (channel) return this.listeners.get(channel)?.size ?? 0;
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0);
  }

  async publish(channel: string, event: RealtimeEvent): Promise<void> {
    this.deliverLocal(channel, event);
    const redis = this.redis();
    if (!redis) return;
    try {
      await whenRedisReady(redis);
      const envelope: Envelope = { origin: this.origin, channel, event };
      await redis.publish(REDIS_TOPIC, JSON.stringify(envelope));
    } catch (error) {
      log.warn(
        { channel: channel.split(":")[0], err: error instanceof Error ? error.name : "unknown" },
        "realtime publish to redis failed",
      );
    }
  }

  private deliverLocal(channel: string, event: RealtimeEvent) {
    for (const listener of this.listeners.get(channel) ?? []) {
      try {
        listener(event);
      } catch (error) {
        log.warn(
          { err: error instanceof Error ? error.name : "unknown" },
          "realtime listener failed",
        );
      }
    }
  }

  private redisUrl(): string | undefined {
    const env = getServerEnv();
    if (env.REALTIME_DRIVER === "memory") return undefined;
    return env.REDIS_URL;
  }

  private redis(): IORedis | undefined {
    const url = this.redisUrl();
    if (!url) return undefined;
    if (!this.publisher) {
      // Fail fast when Redis is down instead of queueing commands in memory.
      this.publisher = new IORedis(url, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: false,
      });
      this.publisher.on("error", () => undefined); // reported through publish failures
    }
    return this.publisher;
  }

  private ensureRedisSubscriber() {
    const url = this.redisUrl();
    if (!url || this.subscriber || this.subscribing) return;
    this.subscribing = true;
    const subscriber = new IORedis(url, { maxRetriesPerRequest: null });
    subscriber.on("error", (error) => log.warn({ err: error.name }, "realtime subscriber error"));
    subscriber.on("message", (_topic, raw) => {
      try {
        const envelope = JSON.parse(raw) as Envelope;
        if (envelope.origin === this.origin) return; // already delivered locally
        this.deliverLocal(envelope.channel, envelope.event);
      } catch {
        /* ignore malformed messages */
      }
    });
    // ioredis re-subscribes automatically after a reconnect.
    void subscriber.subscribe(REDIS_TOPIC).catch(() => undefined);
    this.subscriber = subscriber;
    this.subscribing = false;
  }

  /** Test/shutdown hook. */
  async close() {
    this.listeners.clear();
    this.publisher?.disconnect();
    this.subscriber?.disconnect();
    this.publisher = undefined;
    this.subscriber = undefined;
  }
}

const globalForHub = globalThis as unknown as { realtimeHub?: RealtimeHub };

/** One hub per process (shared across hot reloads and route modules). */
export function getRealtimeHub(): RealtimeHub {
  globalForHub.realtimeHub ??= new RealtimeHub();
  return globalForHub.realtimeHub;
}

export type { RealtimeHub };

/** Publish to a channel through the abstraction. Never throws. */
export async function publishRealtime(channel: string, event: RealtimeEvent): Promise<void> {
  try {
    await getRealtimeHub().publish(channel, event);
  } catch (error) {
    log.warn({ err: error instanceof Error ? error.name : "unknown" }, "realtime publish failed");
  }
}

export function subscribeRealtime(channel: string, listener: Listener): () => void {
  return getRealtimeHub().subscribe(channel, listener);
}
