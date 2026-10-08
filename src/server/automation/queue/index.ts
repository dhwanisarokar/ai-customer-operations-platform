import { getServerEnv } from "@/lib/env";
import { createLogger } from "@/lib/logger";
import { BullMqAutomationQueue } from "./bullmq";
import { MemoryAutomationQueue } from "./memory";
import type { AutomationQueue, JobHandler } from "./types";

const log = createLogger("automation.queue");

let queue: AutomationQueue | undefined;
let inlineStarted = false;

/**
 * The application's automation queue.
 * - REDIS_URL set (or AUTOMATION_QUEUE_DRIVER=bullmq): BullMQ. A separate worker process runs jobs.
 * - Otherwise: an in-process queue whose worker runs inside this same process (development).
 */
export function getAutomationQueue(): AutomationQueue {
  if (!queue) {
    const env = getServerEnv();
    const wantsBull = env.AUTOMATION_QUEUE_DRIVER
      ? env.AUTOMATION_QUEUE_DRIVER === "bullmq"
      : Boolean(env.REDIS_URL);
    if (wantsBull) {
      if (!env.REDIS_URL) throw new Error("REDIS_URL is required for the bullmq queue driver");
      queue = new BullMqAutomationQueue(env.REDIS_URL);
    } else {
      queue = new MemoryAutomationQueue();
      log.warn("REDIS_URL is not set: automations run in-process (development mode)");
    }
  }
  return queue;
}

/**
 * With the in-process driver there is no worker process, so one is started lazily inside this
 * process. With BullMQ this does nothing: `npm run worker` consumes the queue.
 */
export async function ensureInlineWorker(handler: JobHandler): Promise<void> {
  const current = getAutomationQueue();
  if (current.driver !== "memory" || inlineStarted) return;
  inlineStarted = true;
  await current.startWorker(handler);
}

/** Test hook: swap the queue (and reset the inline worker). */
export function setAutomationQueueForTesting(next: AutomationQueue | undefined): void {
  queue = next;
  inlineStarted = false;
}

export type { AutomationQueue } from "./types";
