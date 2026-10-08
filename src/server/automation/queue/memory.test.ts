import { describe, expect, it, vi } from "vitest";
import { MemoryAutomationQueue } from "./memory";
import { UnrecoverableJobError } from "./types";

const job = (id: string) => ({ executionId: id, organizationId: "org" });

describe("MemoryAutomationQueue", () => {
  it("runs enqueued jobs once the worker starts and drains", async () => {
    const queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    const seen: string[] = [];
    await queue.enqueue(job("a")); // enqueued before any worker exists
    await queue.startWorker(async (j) => void seen.push(j.executionId));
    await queue.enqueue(job("b"));
    await queue.drain();
    expect(seen.sort()).toEqual(["a", "b"]);
  });

  it("does not add the same execution twice", async () => {
    const queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    const handler = vi.fn(async () => undefined);
    await queue.startWorker(handler);
    await Promise.all([queue.enqueue(job("a")), queue.enqueue(job("a")), queue.enqueue(job("a"))]);
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries failures with a bounded attempt count and reports attempt numbers", async () => {
    const queue = new MemoryAutomationQueue({ backoffBaseMs: 0, maxAttempts: 3 });
    const attempts: number[] = [];
    await queue.startWorker(async (_job, attempt) => {
      attempts.push(attempt.attempt);
      throw new Error("transient");
    });
    await queue.enqueue(job("a"));
    await queue.drain();
    expect(attempts).toEqual([1, 2, 3]);
  });

  it("succeeds after a transient failure and stops retrying", async () => {
    const queue = new MemoryAutomationQueue({ backoffBaseMs: 0, maxAttempts: 5 });
    const handler = vi.fn(async (_job: unknown, attempt: { attempt: number }) => {
      if (attempt.attempt < 3) throw new Error("transient");
    });
    await queue.startWorker(handler);
    await queue.enqueue(job("a"));
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it("never retries an unrecoverable error", async () => {
    const queue = new MemoryAutomationQueue({ backoffBaseMs: 0, maxAttempts: 5 });
    const handler = vi.fn(async () => {
      throw new UnrecoverableJobError("permanent");
    });
    await queue.startWorker(handler);
    await queue.enqueue(job("a"));
    await queue.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("applies exponential backoff between attempts", async () => {
    vi.useFakeTimers();
    const queue = new MemoryAutomationQueue({ backoffBaseMs: 100, maxAttempts: 3 });
    const times: number[] = [];
    await queue.startWorker(async () => {
      times.push(Date.now());
      throw new Error("transient");
    });
    await queue.enqueue(job("a"));
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    expect(times).toHaveLength(3);
    expect(times[1] - times[0]).toBe(100);
    expect(times[2] - times[1]).toBe(200);
  });
});
