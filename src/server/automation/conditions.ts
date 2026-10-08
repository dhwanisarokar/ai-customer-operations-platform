import { z } from "zod";
import {
  OPERATORS,
  OPERATORS_BY_TYPE,
  TRIGGER_CATALOG,
  type FieldDef,
  type Operator,
  type TriggerName,
} from "./catalog";

/**
 * Deterministic condition engine. Conditions are ANDed. No model is ever involved: a condition is a
 * (field, operator, value) triple checked against the event's data with plain comparisons.
 */

export const MAX_CONDITIONS = 10;

export const conditionSchema = z
  .object({
    field: z.string().min(1).max(60),
    operator: z.enum(OPERATORS),
    value: z.union([z.string().max(500), z.number().finite()]).optional(),
  })
  .strict();
export type Condition = z.output<typeof conditionSchema>;

export const conditionsSchema = z.array(conditionSchema).max(MAX_CONDITIONS);

export type ConditionResult = {
  field: string;
  operator: Operator;
  expected: string | number | null;
  /** Omitted for sensitive fields (e.g. message text). */
  actual?: unknown;
  passed: boolean;
};

/**
 * Checks conditions against what the trigger actually supports. Unsupported fields, operators that do
 * not fit the field's type, missing values and values outside an enum are all rejected. Returns a
 * list of human-readable problems (empty when valid).
 */
export function validateConditions(trigger: TriggerName, conditions: Condition[]): string[] {
  const fields = TRIGGER_CATALOG[trigger].fields;
  const problems: string[] = [];
  conditions.forEach((condition, index) => {
    const at = `Condition ${index + 1}`;
    const field = fields[condition.field];
    if (!field) {
      problems.push(`${at}: "${condition.field}" is not available for ${trigger}.`);
      return;
    }
    if (!OPERATORS_BY_TYPE[field.type].includes(condition.operator)) {
      problems.push(`${at}: "${condition.operator}" cannot be used with ${field.label}.`);
      return;
    }
    if (condition.operator === "exists") return;
    if (condition.value === undefined || condition.value === "") {
      problems.push(`${at}: a value is required.`);
      return;
    }
    if (field.type === "number" && typeof condition.value !== "number") {
      problems.push(`${at}: ${field.label} needs a number.`);
    } else if (field.type !== "number" && typeof condition.value !== "string") {
      problems.push(`${at}: ${field.label} needs text.`);
    } else if (
      field.type === "enum" &&
      !(field.values as readonly string[]).includes(condition.value as string)
    ) {
      problems.push(`${at}: "${condition.value}" is not a valid ${field.label}.`);
    }
  });
  return problems;
}

const norm = (value: unknown) => String(value).toLowerCase();

function check(condition: Condition, field: FieldDef, actual: unknown): boolean {
  const { operator, value } = condition;
  const present =
    actual !== undefined &&
    actual !== null &&
    actual !== "" &&
    !(Array.isArray(actual) && actual.length === 0);
  switch (operator) {
    case "exists":
      return present;
    case "equals":
      return present && norm(actual) === norm(value);
    case "not_equals":
      return !present || norm(actual) !== norm(value);
    case "contains":
      if (!present) return false;
      return Array.isArray(actual)
        ? actual.some((item) => norm(item) === norm(value))
        : norm(actual).includes(norm(value));
    case "not_contains":
      if (!present) return true;
      return Array.isArray(actual)
        ? !actual.some((item) => norm(item) === norm(value))
        : !norm(actual).includes(norm(value));
    case "greater_than":
      return field.type === "number" && typeof actual === "number" && actual > Number(value);
    case "less_than":
      return field.type === "number" && typeof actual === "number" && actual < Number(value);
  }
}

/** Evaluates every condition (no short-circuit, so history shows each result). */
export function evaluateConditions(
  trigger: TriggerName,
  conditions: Condition[],
  data: Record<string, unknown>,
): { passed: boolean; results: ConditionResult[] } {
  const fields = TRIGGER_CATALOG[trigger].fields;
  const results = conditions.map((condition): ConditionResult => {
    const field = fields[condition.field];
    // Unsupported fields never match (they were rejected on save; this is defense in depth).
    const passed = field ? check(condition, field, data[condition.field]) : false;
    return {
      field: condition.field,
      operator: condition.operator,
      expected: condition.value ?? null,
      ...(field && !field.sensitive ? { actual: data[condition.field] ?? null } : {}),
      passed,
    };
  });
  return { passed: results.every((result) => result.passed), results };
}

/** The event data that may be stored: sensitive fields (message text) are dropped. */
export function sanitizeEventData(
  trigger: TriggerName,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const fields = TRIGGER_CATALOG[trigger].fields;
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => fields[key] && !fields[key].sensitive),
  );
}
