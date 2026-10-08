import type { FieldDef, TriggerDef } from "@/server/automation/catalog";

/**
 * Presentation helpers for run history. Ids remain the stored, authoritative values everywhere;
 * these only choose what a person reads. Pure functions over data the server already scoped to the
 * current organization.
 */

export type MemberNames = Record<string, string>;

/** A member id as a name. Someone who left (or an id outside this organization) has no entry. */
export function memberLabel(id: unknown, names: MemberNames): string {
  if (typeof id !== "string" || id === "") return "Unassigned";
  return names[id] ?? "Former member";
}

/** A stored event/condition value as text, resolving member references to names. */
export function displayValue(
  field: FieldDef | undefined,
  value: unknown,
  names: MemberNames,
): string {
  if (field?.ref === "member") return memberLabel(value, names);
  if (Array.isArray(value)) return value.join(", ");
  if (value === null || value === undefined || value === "") return "empty";
  return String(value);
}

/**
 * The note after a condition. For a field that has a "before" counterpart (priority -> previous
 * priority) it is the value BEFORE the change, read from the event itself: `(was NORMAL)`. For any
 * other field it is the value that was evaluated: `(value: OPEN)`. Nothing is hard-coded per field.
 */
export function conditionNote(
  trigger: TriggerDef | undefined,
  condition: { field: string; actual?: unknown },
  eventData: Record<string, unknown>,
  names: MemberNames,
): string | null {
  const field = trigger?.fields[condition.field];
  if (field?.previous && field.previous in eventData) {
    const previousField = trigger?.fields[field.previous];
    return `was ${displayValue(previousField ?? field, eventData[field.previous], names)}`;
  }
  if ("actual" in condition && condition.actual !== undefined) {
    return `value: ${displayValue(field, condition.actual, names)}`;
  }
  return null;
}
