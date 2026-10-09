/**
 * The queue abstraction for automation runs. Only an execution id travels through it: the worker
 * loads everything else (definition, event data) from PostgreSQL, the source of truth. Two drivers
 * implement it: BullMQ/Redis (production) and an in-process one (tests and Redis-less development).
 */
export type AutomationJob = { executionId: string; organizationId: string };

/**
 * The customer-facing AI reply for ONE visitor message. It shares this queue (and its worker, retries
 * and deduplication by job id) with automations: `executionId` is the job id, derived from the
 * message id, so the same message is never queued twice. The worker loads everything else from
 * PostgreSQL.
 */
export type CustomerAiJob = {
  kind: "customer-ai";
  executionId: string;
  organizationId: string;
  conversationId: string;
  messageId: string;
};

export type QueueJob = AutomationJob | CustomerAiJob;

export function isCustomerAiJob(job: QueueJob): job is CustomerAiJob {
  return "kind" in job && job.kind === "customer-ai";
}

export type JobAttempt = { attempt: number; maxAttempts: number };

/** Return normally = done. Throw = retry (until attempts run out). Throw UnrecoverableJobError = stop. */
export type JobHandler = (job: QueueJob, attempt: JobAttempt) => Promise<void>;

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
  enqueue(job: QueueJob): Promise<void>;
  /** Starts processing jobs with `handler` in this process. */
  startWorker(handler: JobHandler): Promise<WorkerHandle>;
  close(): Promise<void>;
}

/** Bounded retries with exponential backoff (shared by both drivers). */
export const QUEUE_NAME = "automation-executions";
export const MAX_ATTEMPTS = 5;
export const BACKOFF_BASE_MS = 2_000;
