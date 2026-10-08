/**
 * The queue abstraction for automation runs. Only an execution id travels through it: the worker
 * loads everything else (definition, event data) from PostgreSQL, the source of truth. Two drivers
 * implement it: BullMQ/Redis (production) and an in-process one (tests and Redis-less development).
 */
export type AutomationJob = { executionId: string; organizationId: string };

export type JobAttempt = { attempt: number; maxAttempts: number };

/** Return normally = done. Throw = retry (until attempts run out). Throw UnrecoverableJobError = stop. */
export type JobHandler = (job: AutomationJob, attempt: JobAttempt) => Promise<void>;

export class UnrecoverableJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnrecoverableJobError";
  }
}

export type WorkerHandle = { close(): Promise<void> };

export interface AutomationQueue {
  readonly driver: "bullmq" | "memory";
  /** Adds a run. A run that is already queued under the same id is not added twice. */
  enqueue(job: AutomationJob): Promise<void>;
  /** Starts processing jobs with `handler` in this process. */
  startWorker(handler: JobHandler): Promise<WorkerHandle>;
  close(): Promise<void>;
}

/** Bounded retries with exponential backoff (shared by both drivers). */
export const QUEUE_NAME = "automation-executions";
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 2_000;
