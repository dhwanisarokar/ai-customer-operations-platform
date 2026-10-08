import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, ValidationError } from "@/server/errors";
import { ACTION_CATALOG, ACTION_NAMES, type ActionDef, type ActionName } from "./catalog";
import {
  addTagToCustomer,
  listCustomerTags,
  removeTagFromCustomer,
} from "@/server/services/customer-tags";
import { addNote } from "@/server/services/customer-notes";
import { assignConversation, updateConversation } from "@/server/services/conversations";

/**
 * The action registry: the ONLY things an automation can do. Every action calls the existing
 * application services with the TRUSTED context built by the worker (the automation creator's
 * current membership), so RBAC, tenant scoping and business rules (status transitions, tag rules,
 * assignee must be a member...) apply exactly as for a person. The target record comes from the
 * event, never from the automation definition.
 */

export type ActionRunContext = {
  ctx: OrganizationContext;
  /** Minimal event data: ids and enum values. */
  data: Record<string, unknown>;
};

export type ActionResult = { note?: string };

export type ActionDefinition = ActionDef & {
  execute: (run: ActionRunContext, input: Record<string, unknown>) => Promise<ActionResult>;
};

function target(run: ActionRunContext, key: "customerId" | "conversationId"): string {
  const value = run.data[key];
  if (typeof value !== "string") {
    throw new ValidationError(
      `This event has no ${key === "customerId" ? "customer" : "conversation"}.`,
    );
  }
  return value;
}

const executors: Record<ActionName, ActionDefinition["execute"]> = {
  async add_customer_tag(run, input) {
    try {
      await addTagToCustomer(run.ctx, target(run, "customerId"), { name: input.tag as string });
      return {};
    } catch (error) {
      // Idempotent: the tag is already there, which is the state the automation wants.
      if (error instanceof ConflictError && /already assigned/i.test(error.message)) {
        return { note: "Tag was already assigned." };
      }
      throw error;
    }
  },

  async remove_customer_tag(run, input) {
    const customerId = target(run, "customerId");
    const wanted = String(input.tag).toLowerCase();
    const tags = await listCustomerTags(run.ctx, customerId);
    const tag = tags.find((candidate) => candidate.name.toLowerCase() === wanted);
    if (!tag) return { note: "Tag was not assigned." };
    await removeTagFromCustomer(run.ctx, customerId, tag.id);
    return {};
  },

  async assign_conversation(run, input) {
    await assignConversation(run.ctx, target(run, "conversationId"), input.assigneeId as string);
    return {};
  },

  async change_conversation_status(run, input) {
    await updateConversation(run.ctx, target(run, "conversationId"), {
      status: input.status as "OPEN" | "PENDING" | "RESOLVED",
    });
    return {};
  },

  async change_conversation_priority(run, input) {
    await updateConversation(run.ctx, target(run, "conversationId"), {
      priority: input.priority as "LOW" | "NORMAL" | "HIGH" | "URGENT",
    });
    return {};
  },

  async create_customer_note(run, input) {
    await addNote(run.ctx, target(run, "customerId"), input.content as string);
    return {};
  },
};

export type ActionRegistry = ReadonlyMap<ActionName, ActionDefinition>;

export function createActionRegistry(
  overrides: Partial<Record<ActionName, ActionDefinition["execute"]>> = {},
): ActionRegistry {
  return new Map(
    ACTION_NAMES.map((name) => [
      name,
      { ...ACTION_CATALOG[name], execute: overrides[name] ?? executors[name] },
    ]),
  );
}

export const actionRegistry: ActionRegistry = createActionRegistry();
