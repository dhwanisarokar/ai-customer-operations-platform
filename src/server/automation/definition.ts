import { z } from "zod";
import { ValidationError } from "@/server/errors";
import {
  ACTION_CATALOG,
  ACTION_NAMES,
  TRIGGER_CATALOG,
  TRIGGER_NAMES,
  isActionName,
  type ActionName,
  type TriggerName,
} from "./catalog";
import { conditionsSchema, validateConditions, type Condition } from "./conditions";

export const MAX_ACTIONS = 10;

export const actionSchema = z
  .object({ type: z.enum(ACTION_NAMES), input: z.record(z.string(), z.unknown()) })
  .strict();
export type StoredAction = { type: ActionName; input: Record<string, unknown> };

/**
 * The body of POST /api/automations. Strict: organizationId, createdBy and any other key are
 * rejected, never ignored. The tenant always comes from the authenticated context.
 */
export const automationInputSchema = z
  .object({
    name: z.string().trim().min(1, "Name is required").max(100),
    description: z
      .string()
      .trim()
      .max(500)
      .nullish()
      .transform((value) => value || null),
    enabled: z.boolean().default(true),
    trigger: z.enum(TRIGGER_NAMES),
    conditions: conditionsSchema.default([]),
    actions: z.array(actionSchema).min(1, "Add at least one action").max(MAX_ACTIONS),
  })
  .strict();
export type AutomationInput = z.output<typeof automationInputSchema>;

export const automationUpdateSchema = z
  .object({
    name: automationInputSchema.shape.name.optional(),
    description: automationInputSchema.shape.description.optional(),
    enabled: z.boolean().optional(),
    trigger: z.enum(TRIGGER_NAMES).optional(),
    conditions: conditionsSchema.optional(),
    actions: automationInputSchema.shape.actions.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field" });
export type AutomationUpdate = z.output<typeof automationUpdateSchema>;

export type Definition = { trigger: TriggerName; conditions: Condition[]; actions: StoredAction[] };

/**
 * Cross-checks a definition against the registries and returns it normalized: conditions fit the
 * trigger's fields and operators, every action input passes its strict schema, and each action has a
 * record to act on for this trigger. Throws a ValidationError listing every problem.
 */
export function validateDefinition(definition: Definition): Definition {
  const problems: string[] = [];
  const trigger = TRIGGER_CATALOG[definition.trigger];
  problems.push(...validateConditions(definition.trigger, definition.conditions));

  const actions = definition.actions.map((action, index): StoredAction => {
    const at = `Action ${index + 1}`;
    if (!isActionName(action.type)) {
      problems.push(`${at}: unknown action "${action.type}".`);
      return action;
    }
    const def = ACTION_CATALOG[action.type];
    if (def.target === "conversation" && !trigger.targets.conversation) {
      problems.push(`${at}: "${def.label}" needs a conversation, but ${trigger.label} has none.`);
    }
    if (def.target === "customer" && !trigger.targets.customer) {
      problems.push(`${at}: "${def.label}" needs a customer, but ${trigger.label} has none.`);
    }
    const parsed = def.inputSchema.safeParse(action.input);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
        problems.push(`${at}: ${path}${issue.message}`);
      }
      return action;
    }
    return { type: action.type, input: parsed.data };
  });

  if (problems.length > 0) {
    throw new ValidationError("The automation is not valid", { problems });
  }
  return { trigger: definition.trigger, conditions: definition.conditions, actions };
}
