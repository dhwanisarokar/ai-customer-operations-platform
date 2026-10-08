import { createLogger } from "@/lib/logger";
import type { Prisma } from "@/generated/prisma/client";
import { ACTION_CATALOG, TRIGGER_CATALOG, isTriggerName } from "@/server/automation/catalog";
import {
  conditionsSchema,
  evaluateConditions,
  type Condition,
} from "@/server/automation/conditions";
import {
  actionSchema,
  validateDefinition,
  type AutomationInput,
  type AutomationUpdate,
  type StoredAction,
} from "@/server/automation/definition";
import type { OrganizationContext } from "@/server/auth/context";
import { NotFoundError, ValidationError } from "@/server/errors";
import { toPage, toSkipTake, type Page } from "@/server/http/pagination";
import {
  automationExecutionsRepository,
  type ExecutionRecord,
} from "@/server/repositories/automation-executions";
import { automationsRepository, type AutomationRecord } from "@/server/repositories/automations";
import { conversationsRepository } from "@/server/repositories/conversations";
import { membershipsRepository } from "@/server/repositories/memberships";
import { collectMemberIds } from "@/server/automation/references";
import { z } from "zod";

const log = createLogger("automations");

export type AutomationDto = {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  conditions: Condition[];
  actions: StoredAction[];
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ExecutionDto = {
  id: string;
  automationId: string;
  eventId: string;
  eventType: string;
  status: ExecutionRecord["status"];
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  eventData: Record<string, unknown>;
  definition: { name: string; trigger: string; conditions: Condition[]; actions: StoredAction[] };
  conditionResults: unknown[];
  actionResults: unknown[];
};

/** A run plus the display names of the organization members it refers to (ids stay the data). */
export type ExecutionDetailDto = ExecutionDto & { memberNames: Record<string, string> };

export function toAutomationDto(record: AutomationRecord): AutomationDto {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    enabled: record.enabled,
    trigger: record.triggerType,
    conditions: record.conditions as Condition[],
    actions: record.actions as StoredAction[],
    createdByUserId: record.createdByUserId,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toExecutionDto(record: ExecutionRecord): ExecutionDto {
  return {
    ...record,
    eventData: record.eventData as Record<string, unknown>,
    definition: record.definition as ExecutionDto["definition"],
    conditionResults: record.conditionResults as unknown[],
    actionResults: record.actionResults as unknown[],
  };
}

async function requireAutomation(ctx: OrganizationContext, id: string) {
  // Another organization's id is indistinguishable from one that does not exist.
  const automation = await automationsRepository.findById(ctx.organization.id, id);
  if (!automation) throw new NotFoundError("Automation not found");
  return automation;
}

/**
 * An automation acts with its creator's permissions, so the person saving it must hold the
 * permission of every action in it (no escalating through an automation), and anything it
 * references must belong to this organization.
 */
async function authorizeActions(ctx: OrganizationContext, actions: StoredAction[]) {
  const problems: string[] = [];
  for (const [index, action] of actions.entries()) {
    const def = ACTION_CATALOG[action.type];
    ctx.require(def.requiredPermission);
    if (action.type === "assign_conversation") {
      const assigneeId = action.input.assigneeId as string;
      if (!(await conversationsRepository.isMember(ctx.organization.id, assigneeId))) {
        problems.push(`Action ${index + 1}: the assignee is not a member of this organization.`);
      }
    }
  }
  if (problems.length > 0) throw new ValidationError("The automation is not valid", { problems });
}

const toJson = (value: unknown) => value as Prisma.InputJsonValue;

export async function listAutomations(
  ctx: OrganizationContext,
  query: { page: number; pageSize: number },
): Promise<Page<AutomationDto>> {
  ctx.require("view_automations");
  const { items, total } = await automationsRepository.list(ctx.organization.id, toSkipTake(query));
  return toPage(items.map(toAutomationDto), total, query);
}

export async function getAutomation(ctx: OrganizationContext, id: string): Promise<AutomationDto> {
  ctx.require("view_automations");
  return toAutomationDto(await requireAutomation(ctx, id));
}

export async function createAutomation(
  ctx: OrganizationContext,
  input: AutomationInput,
): Promise<AutomationDto> {
  ctx.require("create_automations");
  const definition = validateDefinition({
    trigger: input.trigger,
    conditions: input.conditions,
    actions: input.actions,
  });
  await authorizeActions(ctx, definition.actions);

  const created = await automationsRepository.create(ctx.organization.id, ctx.user.id, {
    name: input.name,
    description: input.description,
    enabled: input.enabled,
    triggerType: definition.trigger,
    conditions: toJson(definition.conditions),
    actions: toJson(definition.actions),
  });
  log.info(
    { organizationId: ctx.organization.id, automationId: created.id, actorId: ctx.user.id },
    "automation created",
  );
  return toAutomationDto(created);
}

export async function updateAutomation(
  ctx: OrganizationContext,
  id: string,
  changes: AutomationUpdate,
): Promise<AutomationDto> {
  ctx.require("update_automations");
  const current = await requireAutomation(ctx, id);

  const definition = validateDefinition({
    trigger: (changes.trigger ?? current.triggerType) as AutomationInput["trigger"],
    conditions: changes.conditions ?? (current.conditions as Condition[]),
    actions: changes.actions ?? (current.actions as StoredAction[]),
  });
  await authorizeActions(ctx, definition.actions);

  const updated = await automationsRepository.update(ctx.organization.id, id, {
    ...(changes.name !== undefined ? { name: changes.name } : {}),
    ...(changes.description !== undefined ? { description: changes.description } : {}),
    ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
    triggerType: definition.trigger,
    conditions: toJson(definition.conditions),
    actions: toJson(definition.actions),
  });
  if (!updated) throw new NotFoundError("Automation not found");
  log.info(
    { organizationId: ctx.organization.id, automationId: id, actorId: ctx.user.id },
    "automation updated",
  );
  return toAutomationDto(updated);
}

export async function setAutomationEnabled(
  ctx: OrganizationContext,
  id: string,
  enabled: boolean,
): Promise<AutomationDto> {
  ctx.require("update_automations");
  await requireAutomation(ctx, id);
  const updated = await automationsRepository.update(ctx.organization.id, id, { enabled });
  if (!updated) throw new NotFoundError("Automation not found");
  log.info(
    { organizationId: ctx.organization.id, automationId: id, actorId: ctx.user.id, enabled },
    "automation enabled state changed",
  );
  return toAutomationDto(updated);
}

export async function deleteAutomation(ctx: OrganizationContext, id: string): Promise<void> {
  ctx.require("delete_automations");
  if (!(await automationsRepository.delete(ctx.organization.id, id))) {
    throw new NotFoundError("Automation not found");
  }
  log.info(
    { organizationId: ctx.organization.id, automationId: id, actorId: ctx.user.id },
    "automation deleted",
  );
}

export async function listExecutions(
  ctx: OrganizationContext,
  automationId: string,
  query: { page: number; pageSize: number },
): Promise<Page<ExecutionDto>> {
  ctx.require("view_automations");
  await requireAutomation(ctx, automationId);
  const { items, total } = await automationExecutionsRepository.listForAutomation(
    ctx.organization.id,
    automationId,
    toSkipTake(query),
  );
  return toPage(items.map(toExecutionDto), total, query);
}

export async function getExecution(
  ctx: OrganizationContext,
  automationId: string,
  executionId: string,
): Promise<ExecutionDetailDto> {
  ctx.require("view_automations");
  const execution = await automationExecutionsRepository.findById(ctx.organization.id, executionId);
  if (!execution || execution.automationId !== automationId) {
    throw new NotFoundError("Execution not found");
  }
  const dto = toExecutionDto(execution);

  // One batched, organization-scoped lookup for every member the run mentions. A member who left
  // (or an id from another organization) simply has no entry: the UI shows "Former member".
  const members = await membershipsRepository.listByUserIds(
    ctx.organization.id,
    collectMemberIds(dto),
  );
  return {
    ...dto,
    memberNames: Object.fromEntries(
      members.map((member) => [member.userId, member.name ?? member.email]),
    ),
  };
}

export const testAutomationSchema = z
  .object({ data: z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())])) })
  .strict();

/**
 * Dry run: evaluates the automation's conditions against SAMPLE event data and lists what its
 * actions would do, including whether the caller may run each of them. It executes nothing and
 * cannot be used to bypass authorization.
 */
export async function testAutomation(
  ctx: OrganizationContext,
  id: string,
  body: z.output<typeof testAutomationSchema>,
) {
  ctx.require("execute_automations");
  const automation = await requireAutomation(ctx, id);
  const trigger = isTriggerName(automation.triggerType)
    ? TRIGGER_CATALOG[automation.triggerType]
    : undefined;
  if (!trigger) throw new ValidationError("This automation uses an unknown trigger");

  const unknown = Object.keys(body.data).filter((key) => !trigger.fields[key]);
  if (unknown.length > 0) {
    throw new ValidationError("The sample event has fields this trigger does not provide", {
      problems: unknown.map((key) => `"${key}" is not a field of ${trigger.name}.`),
    });
  }

  const conditions = conditionsSchema.parse(automation.conditions);
  const actions = z.array(actionSchema).parse(automation.actions);
  const evaluation = evaluateConditions(trigger.name, conditions, body.data);
  return {
    wouldRun: evaluation.passed,
    conditionResults: evaluation.results,
    actions: actions.map((action) => ({
      type: action.type,
      input: action.input,
      permitted: ctx.can(ACTION_CATALOG[action.type].requiredPermission),
    })),
  };
}
