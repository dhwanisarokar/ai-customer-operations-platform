import type IORedis from "ioredis";

/**
 * Resolves once the connection is ready (at most `timeoutMs`). Clients created with
 * `enableOfflineQueue: false` reject commands while still connecting, which would make the FIRST
 * command after a process starts always fail; callers wait briefly here and still handle failure.
 */
export function whenRedisReady(redis: IORedis, timeoutMs = 1500): Promise<void> {
  if (redis.status === "ready") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      redis.off("ready", done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    redis.once("ready", done);
  });
}
