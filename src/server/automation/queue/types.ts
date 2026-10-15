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

/**
 * A wake-up for ONE outbound email (Phase 9.3A). It carries ids only: the database row in `outbound_emails` is the
 * source of truth and the worker re-reads everything, claims the send atomically and may find it already done. A job
 * that is duplicated, late or lost is therefore harmless: a lost one is re-created by the reconciler.
 * `executionId` includes the attempt number so a LATER retry is not swallowed by the queue's deduplication of an
 * earlier, already-completed job id. (BullMQ ids may not contain ":".)
 */
export type EmailSendJob = {
  kind: "email-send";
  executionId: string;
  organizationId: string;
  sendId: string;
};

export type QueueJob = AutomationJob | CustomerAiJob | EmailSendJob;

export function isCustomerAiJob(job: QueueJob): job is CustomerAiJob {
  return "kind" in job && job.kind === "customer-ai";
}

export function isEmailSendJob(job: QueueJob): job is EmailSendJob {
  return "kind" in job && job.kind === "email-send";
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
