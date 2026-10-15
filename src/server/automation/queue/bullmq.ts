import { Queue, UnrecoverableError, Worker } from "bullmq";
import IORedis from "ioredis";
import { createLogger } from "@/lib/logger";
import {
  BACKOFF_BASE_MS,
  MAX_ATTEMPTS,
  QUEUE_NAME,
  UnrecoverableJobError,
  isEmailSendJob,
  type QueueJob,
  type AutomationQueue,
  type JobHandler,
  type WorkerHandle,
} from "./types";

const log = createLogger("automation.queue");

/**
 * BullMQ driver (Redis). The web process only produces jobs; a separate worker process
 * (`npm run worker`) consumes them. Job id = execution id, so enqueueing the same run twice is a
 * no-op at the queue level as well as in PostgreSQL.
 */
export class BullMqAutomationQueue implements AutomationQueue {
  readonly driver = "bullmq" as const;
  private queue: Queue | undefined;
  private producerConnection: IORedis | undefined;
  private readonly workerConnections: IORedis[] = [];

  constructor(private readonly redisUrl: string) {}

  private getQueue(): Queue {
    if (!this.queue) {
      // A producer should fail fast when Redis is down instead of hanging the request.
      this.producerConnection = new IORedis(this.redisUrl, {
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      this.producerConnection.on("error", (error) =>
        log.warn({ err: error.name }, "redis producer connection error"),
      );
      this.queue = new Queue(QUEUE_NAME, {
        connection: this.producerConnection,
        defaultJobOptions: {
          attempts: MAX_ATTEMPTS,
          backoff: { type: "exponential", delay: BACKOFF_BASE_MS },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
    }
    return this.queue;
  }

  async enqueue(job: QueueJob): Promise<void> {
    await this.getQueue().add(
      "run",
      job,
      isEmailSendJob(job)
        ? // A wake-up is only a HINT (the database row is the truth). BullMQ ignores an `add` whose job id still exists in
          // ANY set, and retained completed jobs keep their id for an hour: a job that completed without sending (not
          // due yet, provider unavailable, lost claim) would then swallow every later wake-up with the same id. So these
          // jobs are removed the moment they finish; the id only dedupes a job that is waiting, delayed or running.
          // A wake-up that arrives while one is running is dropped, which is bounded: the maintenance pass (about a
          // minute) re-queues anything still due.
          { jobId: job.executionId, removeOnComplete: true, removeOnFail: true }
        : { jobId: job.executionId },
    );
  }

  async startWorker(handler: JobHandler): Promise<WorkerHandle> {
    // Workers need blocking commands, so maxRetriesPerRequest must be null.
    const connection = new IORedis(this.redisUrl, { maxRetriesPerRequest: null });
    this.workerConnections.push(connection);
    const worker = new Worker<QueueJob>(
      QUEUE_NAME,
      async (job) => {
        try {
          await handler(job.data, {
            attempt: job.attemptsMade + 1,
            maxAttempts: job.opts.attempts ?? 1,
          });
        } catch (error) {
          if (error instanceof UnrecoverableJobError) throw new UnrecoverableError(error.message);
          throw error;
        }
      },
      { connection, concurrency: 5 },
    );
    worker.on("error", (error) => log.error({ err: error.name }, "worker error"));
    worker.on("failed", (job, error) =>
      log.warn(
        { executionId: job?.data.executionId, attempt: job?.attemptsMade, err: error.name },
        "job attempt failed",
      ),
    );
    await worker.waitUntilReady();
    return {
      // Graceful: lets running jobs finish before closing.
      close: async () => {
        await worker.close();
        connection.disconnect();
      },
    };
  }

  async close(): Promise<void> {
    await this.queue?.close();
    this.producerConnection?.disconnect();
    for (const connection of this.workerConnections) connection.disconnect();
    this.queue = undefined;
  }
}
