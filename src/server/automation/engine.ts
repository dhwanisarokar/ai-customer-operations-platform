import { createLogger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import type { DomainEvent } from "@/server/events/types";
import { automationExecutionsRepository } from "@/server/repositories/automation-executions";
import { automationsRepository } from "@/server/repositories/automations";
import { actionSchema } from "./definition";
import { conditionsSchema, evaluateConditions, sanitizeEventData } from "./conditions";
import { getTrigger } from "./triggers";
import { ensureInlineWorker, getAutomationQueue, type AutomationQueue } from "./queue";
import { processAutomationJob } from "./runner";
import { z } from "zod";

const log = createLogger("automation.engine");

const actionsSchema = z.array(actionSchema);

export type DispatchResult = { matched: number; queued: number; duplicates: number };

/**
 * Event -> automations. For one domain event:
 *   1. find this organization's ENABLED automations for the trigger,
 *   2. evaluate their conditions (deterministic, no model),
 *   3. create one execution per matching automation (unique per automation + event id), then
 *   4. enqueue it. The queue carries only the execution id; the worker reads everything from PostgreSQL.
 *
 * Replaying an event (same id) never creates or runs a second execution.
 */
export async function dispatchDomainEvent(
  event: DomainEvent,
  deps: { queue?: AutomationQueue } = {},
): Promise<DispatchResult> {
  const result: DispatchResult = { matched: 0, queued: 0, duplicates: 0 };
  // Changes made by an automation's own actions never start automations (no loops).
  if (event.causedByAutomation) return result;
  const trigger = getTrigger(event.type);
  if (!trigger) return result;

  const automations = await automationsRepository.listEnabledForTrigger(
    event.organizationId,
    event.type,
  );
  const data = event.data as Record<string, unknown>;

  for (const automation of automations) {
    const conditions = conditionsSchema.safeParse(automation.conditions);
    const actions = actionsSchema.safeParse(automation.actions);
    if (!conditions.success || !actions.success) {
      log.warn(
        { organizationId: event.organizationId, automationId: automation.id },
        "stored automation definition is invalid; skipped",
      );
      continue;
    }

    const evaluation = evaluateConditions(event.type, conditions.data, data);
    if (!evaluation.passed) continue;
    result.matched++;

    const execution = await automationExecutionsRepository.createIfAbsent(event.organizationId, {
      automationId: automation.id,
      eventId: event.id,
      eventType: event.type,
      eventData: sanitizeEventData(event.type, data) as Prisma.InputJsonValue,
      definition: {
        name: automation.name,
        trigger: event.type,
        conditions: conditions.data,
        actions: actions.data,
      } as unknown as Prisma.InputJsonValue,
      conditionResults: evaluation.results as unknown as Prisma.InputJsonValue,
    });
    if (!execution) {
      result.duplicates++;
      log.info(
        { organizationId: event.organizationId, automationId: automation.id, eventId: event.id },
        "duplicate event ignored",
      );
      continue;
    }

    log.info(
      {
        organizationId: event.organizationId,
        automationId: automation.id,
        executionId: execution.id,
        eventId: event.id,
        eventType: event.type,
      },
      "automation triggered",
    );

    try {
      const queue = deps.queue ?? getAutomationQueue();
      if (!deps.queue) await ensureInlineWorker(processAutomationJob);
      await queue.enqueue({ executionId: execution.id, organizationId: event.organizationId });
      result.queued++;
    } catch (error) {
      // The run is recorded but could not be queued (e.g. Redis down). Make it visible, don't lose it.
      log.error(
        {
          organizationId: event.organizationId,
          automationId: automation.id,
          executionId: execution.id,
          err: error instanceof Error ? error.name : "unknown",
        },
        "failed to enqueue automation execution",
      );
      await automationExecutionsRepository.finishQueued(
        event.organizationId,
        execution.id,
        {
          status: "FAILED",
          errorCode: "QUEUE_UNAVAILABLE",
          errorMessage:
            "The job queue is not reachable. Start Redis and the worker (npm run worker), or set AUTOMATION_QUEUE_DRIVER=memory for development.",
        },
        new Date(),
      );
    }
  }
  return result;
}
