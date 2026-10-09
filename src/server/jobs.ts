import { processAutomationJob } from "@/server/automation/runner";
import { isCustomerAiJob, type JobAttempt, type QueueJob } from "@/server/automation/queue/types";
import { processCustomerAiJob } from "@/server/services/customer-ai";

/**
 * The one handler of the shared job queue: automation executions and customer-facing AI replies.
 * The worker process (`npm run worker`) and the in-process development worker both use it.
 */
export function processQueueJob(job: QueueJob, attempt: JobAttempt): Promise<void> {
  return isCustomerAiJob(job)
    ? processCustomerAiJob(job, attempt)
    : processAutomationJob(job, attempt);
}
