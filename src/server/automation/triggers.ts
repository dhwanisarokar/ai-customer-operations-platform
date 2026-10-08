import {
  TRIGGER_CATALOG,
  TRIGGER_NAMES,
  isTriggerName,
  type TriggerDef,
  type TriggerName,
} from "./catalog";

/**
 * The trigger registry: which domain events automations can start from, and which condition fields
 * each one supports. Entries live in the catalog (shared with the dashboard builder); adding a
 * trigger never touches the engine.
 */
export type TriggerRegistry = ReadonlyMap<TriggerName, TriggerDef>;

export const triggerRegistry: TriggerRegistry = new Map(
  TRIGGER_NAMES.map((name) => [name, TRIGGER_CATALOG[name]]),
);

export function getTrigger(name: string): TriggerDef | undefined {
  return isTriggerName(name) ? triggerRegistry.get(name) : undefined;
}

export function listTriggers(): TriggerDef[] {
  return [...triggerRegistry.values()];
}
