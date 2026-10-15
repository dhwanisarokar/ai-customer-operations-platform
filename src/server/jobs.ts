import { processAutomationJob } from "@/server/automation/runner";
import {
  isCustomerAiJob,
  isEmailSendJob,
  type JobAttempt,
  type QueueJob,
} from "@/server/automation/queue/types";
import { processEmailSendJob } from "@/server/email/outbound";
import { processCustomerAiJob } from "@/server/services/customer-ai";

/**
 * The one handler of the shared job queue: automation executions, customer-facing AI replies and outbound email
 * wake-ups.
 * The worker process (`npm run worker`) and the in-process development worker both use it.
 */
export function processQueueJob(job: QueueJob, attempt: JobAttempt): Promise<void> {
  if (isCustomerAiJob(job)) return processCustomerAiJob(job, attempt);
  if (isEmailSendJob(job)) return processEmailSendJob(job);
  return processAutomationJob(job, attempt);
}
