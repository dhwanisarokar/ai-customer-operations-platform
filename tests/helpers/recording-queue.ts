import type { AutomationQueue, QueueJob, WorkerHandle } from "@/server/automation/queue/types";

/**
 * A queue double that only RECORDS what is enqueued and never runs it, so a test decides when (and how often, and
 * in what order) a job is processed. It reports the "bullmq" driver so the application does not start an in-process
 * worker for it. `failEnqueue` simulates an unavailable or lossy queue (Redis down, a job lost).
 */
export class RecordingQueue implements AutomationQueue {
  readonly driver = "bullmq" as const;
  readonly jobs: QueueJob[] = [];
  failEnqueue = false;

  async enqueue(job: QueueJob): Promise<void> {
    if (this.failEnqueue) throw new Error("queue unavailable");
    this.jobs.push(job);
  }

  async startWorker(): Promise<WorkerHandle> {
    return { close: async () => undefined };
  }

  async close(): Promise<void> {
    return undefined;
  }

  /** Jobs of the outbound email kind, in order. */
  emailJobs() {
    return this.jobs.filter(
      (job): job is Extract<QueueJob, { kind: "email-send" }> =>
        "kind" in job && job.kind === "email-send",
    );
  }

  /** Forget everything recorded so far (a "restart" of the queue: Redis lost its jobs). */
  clear() {
    this.jobs.length = 0;
  }
}
