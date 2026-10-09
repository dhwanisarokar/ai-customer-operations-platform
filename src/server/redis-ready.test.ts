import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { whenRedisReady } from "./redis-ready";

const fake = (status: string) => Object.assign(new EventEmitter(), { status }) as never;

describe("whenRedisReady", () => {
  it("resolves immediately when the connection is ready", async () => {
    await expect(whenRedisReady(fake("ready"))).resolves.toBeUndefined();
  });

  it("waits for the ready event instead of failing the first command", async () => {
    const redis = fake("connecting") as unknown as EventEmitter;
    let resolved = false;
    const waiting = whenRedisReady(redis as never, 1000).then(() => (resolved = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);
    redis.emit("ready");
    await waiting;
    expect(resolved).toBe(true);
  });

  it("gives up after the timeout so the caller can fall back", async () => {
    const started = Date.now();
    await whenRedisReady(fake("connecting"), 50);
    expect(Date.now() - started).toBeGreaterThanOrEqual(40);
  });
});
