/**
 * Automation worker: consumes the BullMQ queue: automation executions and customer-facing AI replies.
 *
 *   npm run worker
 *
 * Needs REDIS_URL (or AUTOMATION_QUEUE_DRIVER=bullmq) and the same DATABASE_URL as the web app.
 * Run any number of workers: ownership of a run is taken with one atomic database update, so two
 * workers never run the same execution. SIGINT/SIGTERM stop it gracefully (running jobs finish).
 */
import "dotenv/config";
import { createLogger } from "@/lib/logger";
import { assertRuntimeConfig } from "@/lib/runtime-config";
import { getAutomationQueue } from "@/server/automation/queue";
import { processQueueJob } from "@/server/jobs";
import { startMaintenanceLoop } from "@/server/maintenance";

const log = createLogger("automation.worker");

async function main() {
  // A production worker with incomplete configuration refuses to start (names of missing variables only).
  assertRuntimeConfig("worker");
  const queue = getAutomationQueue();
  if (queue.driver !== "bullmq") {
    throw new Error(
      "The worker needs Redis. Set REDIS_URL (and leave AUTOMATION_QUEUE_DRIVER unset or 'bullmq').",
    );
  }
  const worker = await queue.startWorker(processQueueJob);
  log.info("automation worker started");
  // Housekeeping that must survive restarts (durable events, retention, operational gauges). Safe to run in
  // every worker: see src/server/maintenance.ts.
  const stopMaintenance = startMaintenanceLoop();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down: waiting for running jobs to finish");
    await stopMaintenance();
    await worker.close();
    await queue.close();
    log.info("automation worker stopped");
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((error) => {
  console.error(
    `Worker failed to start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
