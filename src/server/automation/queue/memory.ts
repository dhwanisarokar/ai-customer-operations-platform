import {
  BACKOFF_BASE_MS,
  MAX_ATTEMPTS,
  UnrecoverableJobError,
  isEmailSendJob,
  type QueueJob,
  type AutomationQueue,
  type JobHandler,
  type WorkerHandle,
} from "./types";

type Options = {
  /** Base delay of the exponential backoff. Tests use 0. */
  backoffBaseMs?: number;
  maxAttempts?: number;
};

/**
 * In-process queue with the same semantics as the BullMQ driver (deduplicated job ids, bounded
 * retries, exponential backoff, unrecoverable errors). Used by the tests and for local development
 * without Redis. It does not survive a restart, which is why production uses BullMQ.
 */
export class MemoryAutomationQueue implements AutomationQueue {
  readonly driver = "memory" as const;
  private handler: JobHandler | undefined;
  private readonly waiting: QueueJob[] = [];
  private readonly known = new Set<string>();
  private active = 0;
  private closed = false;
  private idleWaiters: (() => void)[] = [];
  private readonly backoffBaseMs: number;
  private readonly maxAttempts: number;

  constructor(options: Options = {}) {
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  }

  async enqueue(job: QueueJob): Promise<void> {
    if (this.closed || this.known.has(job.executionId)) return;
    this.known.add(job.executionId);
    this.waiting.push(job);
    this.pump();
  }

  async startWorker(handler: JobHandler): Promise<WorkerHandle> {
    this.handler = handler;
    this.pump();
    return { close: () => this.close() };
  }

  /** Resolves when nothing is queued or running (including pending retries). Test helper. */
  drain(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.drain();
  }

  private isIdle() {
    return this.active === 0 && (this.waiting.length === 0 || !this.handler);
  }

  private pump() {
    while (this.handler && this.waiting.length > 0) {
      const job = this.waiting.shift()!;
      this.active++;
      void this.run(job).finally(() => {
        this.active--;
        // Same rule as the BullMQ driver: an email wake-up only dedupes while it is queued or running.
        if (isEmailSendJob(job)) this.known.delete(job.executionId);
        if (this.isIdle()) this.idleWaiters.splice(0).forEach((resolve) => resolve());
      });
    }
  }

  private async run(job: QueueJob) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        await this.handler!(job, { attempt, maxAttempts: this.maxAttempts });
        return;
      } catch (error) {
        if (error instanceof UnrecoverableJobError || attempt === this.maxAttempts) return;
        const delay = this.backoffBaseMs * 2 ** (attempt - 1);
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}
