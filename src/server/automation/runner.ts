import { ZodError } from "zod";
import type { Prisma } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import { contextFromMembership, type OrganizationContext } from "@/server/auth/context";
import { AppError } from "@/server/errors";
import { runAsAutomation } from "@/server/events/bus";
import { automationExecutionsRepository } from "@/server/repositories/automation-executions";
import { automationsRepository } from "@/server/repositories/automations";
import { membershipsRepository } from "@/server/repositories/memberships";
import { actionRegistry, type ActionRegistry } from "./actions";
import { isActionName } from "./catalog";
import type { StoredAction } from "./definition";
import { UnrecoverableJobError, type AutomationJob, type JobAttempt } from "./queue/types";

const log = createLogger("automation.runner");

export type ActionRunRecord = {
  index: number;
  action: string;
  status: "completed" | "failed";
  startedAt: string;
  completedAt: string;
  note?: string;
  error?: { code: string; message: string };
};

type Failure = { code: string; message: string; retryable: boolean };

/** Maps anything thrown by an action to a safe, actionable record. Raw internals are only logged. */
function classify(error: unknown): Failure {
  if (error instanceof AppError) {
    // Business-rule and authorization errors are deterministic: retrying cannot change them.
    return { code: error.code.toUpperCase(), message: error.message, retryable: false };
  }
  if (error instanceof ZodError) {
    return {
      code: "VALIDATION_ERROR",
      message: "The action input is not valid.",
      retryable: false,
    };
  }
  return {
    code: "EXECUTION_ERROR",
    message: "An unexpected error occurred while running the action.",
    retryable: true,
  };
}

/**
 * The trusted context for a run: the automation creator's CURRENT membership and role, loaded with
 * one query. A creator who left the organization (or no longer exists) cannot run anything.
 */
async function buildRunContext(
  organizationId: string,
  userId: string,
): Promise<OrganizationContext> {
  const source = await membershipsRepository.findContextSource(userId, organizationId);
  if (!source) {
    throw new AppError(
      403,
      "forbidden",
      "The automation's owner no longer belongs to this organization.",
    );
  }
  return contextFromMembership(source.user, source);
}

/**
 * The worker's job handler. It is safe to call any number of times for the same execution, from any
 * number of workers: ownership is taken with one atomic update, finished runs are never re-run, and
 * actions that already completed are skipped when a run is retried or taken over.
 */
export async function processAutomationJob(
  job: AutomationJob,
  attempt: JobAttempt,
  deps: { actions?: ActionRegistry; now?: () => Date } = {},
): Promise<void> {
  const registry = deps.actions ?? actionRegistry;
  const now = deps.now ?? (() => new Date());
  const { organizationId, executionId } = job;

  const execution = await automationExecutionsRepository.findById(organizationId, executionId);
  if (!execution) throw new UnrecoverableJobError("Execution not found");
  if (["COMPLETED", "FAILED", "CANCELLED"].includes(execution.status)) {
    log.info({ organizationId, executionId }, "execution already finished; nothing to do");
    return;
  }

  const automation = await automationsRepository.findById(organizationId, execution.automationId);
  if (!automation?.enabled) {
    await automationExecutionsRepository.finishQueued(
      organizationId,
      executionId,
      {
        status: "CANCELLED",
        errorCode: "AUTOMATION_DISABLED",
        errorMessage: "The automation was disabled before this run started.",
      },
      now(),
    );
    log.info({ organizationId, executionId }, "automation disabled; run cancelled");
    return;
  }

  // Taking ownership and loading the creator's context do not depend on each other: run them
  // together. The context is only used if the claim was won (a failure to build it is captured, not
  // thrown, and handled below exactly as before: it fails the run permanently).
  const contextPromise = buildRunContext(organizationId, automation.createdByUserId).then(
    (ctx) => ({ ctx }),
    (error: unknown) => ({ error }),
  );
  const [claimed, contextResult] = await Promise.all([
    automationExecutionsRepository.claim(organizationId, executionId, now()),
    contextPromise,
  ]);
  if (!claimed) {
    log.info({ organizationId, executionId }, "execution is owned by another worker; skipped");
    return;
  }

  const base = {
    organizationId,
    automationId: execution.automationId,
    executionId,
    eventId: execution.eventId,
  };
  log.info({ ...base, attempt: attempt.attempt }, "execution started");

  const definition = execution.definition as unknown as { actions: StoredAction[] };
  const eventData = execution.eventData as Record<string, unknown>;
  const records = (
    Array.isArray(execution.actionResults) ? execution.actionResults : []
  ) as ActionRunRecord[];
  const results: ActionRunRecord[] = [];

  const fail = async (failure: Failure) => {
    const retry = failure.retryable && attempt.attempt < attempt.maxAttempts;
    await automationExecutionsRepository.settle(
      organizationId,
      executionId,
      {
        status: retry ? "QUEUED" : "FAILED",
        actionResults: results as unknown as Prisma.InputJsonValue,
        errorCode: failure.code,
        errorMessage: failure.message,
      },
      now(),
    );
    if (retry) throw new Error(`${failure.code}: retrying`);
    throw new UnrecoverableJobError(`${failure.code}: ${failure.message}`);
  };

  if ("error" in contextResult) return fail(classify(contextResult.error));
  const { ctx } = contextResult;

  for (const [index, stored] of definition.actions.entries()) {
    const previous = records.find((record) => record.index === index);
    if (previous?.status === "completed") {
      results.push(previous); // survives a retry or a takeover: never run twice
      continue;
    }

    const startedAt = now().toISOString();
    log.info({ ...base, action: stored.type }, "action started");
    try {
      const def = isActionName(stored.type) ? registry.get(stored.type) : undefined;
      if (!def) throw new AppError(400, "validation_error", `Unknown action "${stored.type}".`);
      const input = def.inputSchema.parse(stored.input);
      ctx.require(def.requiredPermission); // the creator's CURRENT role, not the role at save time
      const outcome = await runAsAutomation(execution.automationId, () =>
        def.execute({ ctx, data: eventData }, input),
      );
      results.push({
        index,
        action: stored.type,
        status: "completed",
        startedAt,
        completedAt: now().toISOString(),
        ...(outcome.note ? { note: outcome.note } : {}),
      });
      // Record progress so a retry or takeover skips this action. The LAST action needs no
      // separate write: the final update below stores the results together with COMPLETED, so the
      // window between "effect applied" and "recorded" is exactly the same, with one round trip less.
      if (index < definition.actions.length - 1) {
        await automationExecutionsRepository.saveProgress(
          organizationId,
          executionId,
          results as unknown as Prisma.InputJsonValue,
          now(),
        );
      }
      log.info({ ...base, action: stored.type }, "action completed");
    } catch (error) {
      const failure = classify(error);
      results.push({
        index,
        action: stored.type,
        status: "failed",
        startedAt,
        completedAt: now().toISOString(),
        error: { code: failure.code, message: failure.message },
      });
      log.warn(
        { ...base, action: stored.type, code: failure.code, retryable: failure.retryable },
        "action failed",
      );
      return fail(failure);
    }
  }

  await automationExecutionsRepository.settle(
    organizationId,
    executionId,
    { status: "COMPLETED", actionResults: results as unknown as Prisma.InputJsonValue },
    now(),
  );
  log.info(base, "execution completed");
}
