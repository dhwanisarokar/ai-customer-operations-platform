import { ACTION_CATALOG, TRIGGER_CATALOG, isActionName, isTriggerName } from "./catalog";

/**
 * The organization-member ids an execution refers to (event data, action inputs and condition
 * results). Ids stay the authoritative value everywhere they are stored; this only finds them so the
 * history can show names. Pure: no database access.
 */
export function collectMemberIds(execution: {
  eventType: string;
  eventData: Record<string, unknown>;
  definition: { actions: { type: string; input: Record<string, unknown> }[] };
  conditionResults: unknown[];
}): string[] {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value) ids.add(value);
  };

  const fields = isTriggerName(execution.eventType)
    ? TRIGGER_CATALOG[execution.eventType].fields
    : {};
  for (const [key, field] of Object.entries(fields)) {
    if (field.ref === "member") add(execution.eventData[key]);
  }
  for (const action of execution.definition.actions) {
    if (!isActionName(action.type)) continue;
    for (const key of ACTION_CATALOG[action.type].memberFields ?? []) add(action.input[key]);
  }
  for (const result of execution.conditionResults as {
    field?: string;
    expected?: unknown;
    actual?: unknown;
  }[]) {
    if (result.field && fields[result.field]?.ref === "member") {
      add(result.expected);
      add(result.actual);
    }
  }
  return [...ids];
}
