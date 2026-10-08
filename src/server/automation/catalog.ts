import { z } from "zod";
import { CONVERSATION_PRIORITIES, CONVERSATION_STATUSES } from "@/features/conversations/schemas";
import { CUSTOMER_STATUSES, tagNameSchema } from "@/features/customers/schemas";
import type { Permission } from "@/server/auth/permissions";

/**
 * The static description of what automations can react to (triggers) and do (actions). It is plain
 * data plus Zod schemas with no server imports, so the dashboard builder and the server registries
 * share one definition. Adding a trigger or an action means adding an entry here (and, for an
 * action, an `execute` in `actions.ts`).
 */

// ---- fields and operators --------------------------------------------------------------------

export type FieldType = "string" | "id" | "enum" | "number" | "list";

export type FieldDef = {
  label: string;
  type: FieldType;
  /** Allowed values for `enum` fields. */
  values?: readonly string[];
  /** Evaluated for conditions but never stored (e.g. message text). */
  sensitive?: boolean;
  /** The event field holding this field's value BEFORE the change (e.g. priority -> previousPriority). */
  previous?: string;
  /** The value is an organization member's user id; the UI shows the member's name instead. */
  ref?: "member";
};

export const OPERATORS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "exists",
  "greater_than",
  "less_than",
] as const;
export type Operator = (typeof OPERATORS)[number];

export const OPERATORS_BY_TYPE: Record<FieldType, readonly Operator[]> = {
  string: ["equals", "not_equals", "contains", "not_contains", "exists"],
  id: ["equals", "not_equals", "exists"],
  enum: ["equals", "not_equals", "exists"],
  number: ["equals", "not_equals", "greater_than", "less_than", "exists"],
  list: ["contains", "not_contains", "exists"],
};

export const OPERATOR_LABELS: Record<Operator, string> = {
  equals: "equals",
  not_equals: "does not equal",
  contains: "contains",
  not_contains: "does not contain",
  exists: "exists",
  greater_than: "is greater than",
  less_than: "is less than",
};

// ---- triggers --------------------------------------------------------------------------------

const customerStatus = {
  label: "Customer status",
  type: "enum",
  values: CUSTOMER_STATUSES,
} as const;
const priority = { label: "Priority", type: "enum", values: CONVERSATION_PRIORITIES } as const;
const status = { label: "Status", type: "enum", values: CONVERSATION_STATUSES } as const;

const customerId = { label: "Customer", type: "id" } as const;
const conversationId = { label: "Conversation", type: "id" } as const;

export type TriggerDef = {
  name: TriggerName;
  label: string;
  description: string;
  /** Condition fields: the keys of the event's `data`. */
  fields: Record<string, FieldDef>;
  /** Which records an action can act on when this trigger fires. */
  targets: { customer: boolean; conversation: boolean };
};

export const TRIGGER_NAMES = [
  "customer.created",
  "customer.updated",
  "conversation.created",
  "conversation.status_changed",
  "conversation.priority_changed",
  "conversation.assigned",
  "message.created",
  "customer.tag_added",
  "customer.tag_removed",
] as const;
export type TriggerName = (typeof TRIGGER_NAMES)[number];

export const TRIGGER_CATALOG: Record<TriggerName, TriggerDef> = {
  "customer.created": {
    name: "customer.created",
    label: "Customer created",
    description: "A new customer is added to the organization.",
    fields: {
      customerId,
      status: customerStatus,
      company: { label: "Company", type: "string" },
      source: { label: "Source", type: "string" },
    },
    targets: { customer: true, conversation: false },
  },
  "customer.updated": {
    name: "customer.updated",
    label: "Customer updated",
    description: "A customer's profile changes.",
    fields: {
      customerId,
      status: customerStatus,
      company: { label: "Company", type: "string" },
      changedFields: { label: "Changed fields", type: "list" },
    },
    targets: { customer: true, conversation: false },
  },
  "conversation.created": {
    name: "conversation.created",
    label: "Conversation created",
    description: "A new conversation is started.",
    fields: {
      conversationId,
      customerId,
      priority,
      status,
      channel: { label: "Channel", type: "enum", values: ["IN_APP"] },
    },
    targets: { customer: true, conversation: true },
  },
  "conversation.status_changed": {
    name: "conversation.status_changed",
    label: "Conversation status changed",
    description: "A conversation moves to another status.",
    fields: {
      conversationId,
      customerId,
      status: { ...status, label: "New status", previous: "previousStatus" },
      previousStatus: { ...status, label: "Previous status" },
      priority,
      assignee: { label: "Assignee", type: "id", ref: "member" },
    },
    targets: { customer: true, conversation: true },
  },
  "conversation.priority_changed": {
    name: "conversation.priority_changed",
    label: "Conversation priority changed",
    description: "A conversation's priority changes.",
    fields: {
      conversationId,
      customerId,
      priority: { ...priority, label: "New priority", previous: "previousPriority" },
      previousPriority: { ...priority, label: "Previous priority" },
      status,
      assignee: { label: "Assignee", type: "id", ref: "member" },
    },
    targets: { customer: true, conversation: true },
  },
  "conversation.assigned": {
    name: "conversation.assigned",
    label: "Conversation assigned",
    description: "A conversation is assigned to a member.",
    fields: {
      conversationId,
      customerId,
      assignee: { label: "New assignee", type: "id", ref: "member", previous: "previousAssignee" },
      previousAssignee: { label: "Previous assignee", type: "id", ref: "member" },
      status,
      priority,
    },
    targets: { customer: true, conversation: true },
  },
  "message.created": {
    name: "message.created",
    label: "Message added",
    description: "A message or internal note is added to a conversation.",
    fields: {
      messageId: { label: "Message", type: "id" },
      conversationId,
      customerId,
      senderType: {
        label: "Sender",
        type: "enum",
        values: ["CUSTOMER", "USER", "SYSTEM", "AI_AGENT"],
      },
      messageType: { label: "Type", type: "enum", values: ["MESSAGE", "INTERNAL_NOTE"] },
      body: { label: "Message text", type: "string", sensitive: true },
    },
    targets: { customer: true, conversation: true },
  },
  "customer.tag_added": {
    name: "customer.tag_added",
    label: "Tag added to customer",
    description: "A tag is assigned to a customer.",
    fields: {
      customerId,
      tagId: { label: "Tag", type: "id" },
      tagName: { label: "Tag name", type: "string" },
    },
    targets: { customer: true, conversation: false },
  },
  "customer.tag_removed": {
    name: "customer.tag_removed",
    label: "Tag removed from customer",
    description: "A tag is removed from a customer.",
    fields: {
      customerId,
      tagId: { label: "Tag", type: "id" },
      tagName: { label: "Tag name", type: "string" },
    },
    targets: { customer: true, conversation: false },
  },
};

// ---- actions ---------------------------------------------------------------------------------

export const ACTION_NAMES = [
  "add_customer_tag",
  "remove_customer_tag",
  "assign_conversation",
  "change_conversation_status",
  "change_conversation_priority",
  "create_customer_note",
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export type ActionDef = {
  name: ActionName;
  label: string;
  description: string;
  /** Strict: unknown keys (e.g. organizationId) are rejected. */
  inputSchema: z.ZodType<Record<string, unknown>>;
  /** Checked against the automation's creator, when saving AND every time it runs. */
  requiredPermission: Permission;
  /** The record the action acts on, taken from the event (never from the definition). */
  target: "customer" | "conversation";
  /** Input keys that hold an organization member's user id (shown by name in run history). */
  memberFields?: readonly string[];
};

const strict = <T extends z.ZodRawShape>(shape: T) =>
  z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;

export const ACTION_CATALOG: Record<ActionName, ActionDef> = {
  add_customer_tag: {
    name: "add_customer_tag",
    label: "Add tag to customer",
    description: "Adds a tag (created if needed) to the customer in the event.",
    inputSchema: strict({ tag: tagNameSchema }),
    requiredPermission: "tag_customers",
    target: "customer",
  },
  remove_customer_tag: {
    name: "remove_customer_tag",
    label: "Remove tag from customer",
    description: "Removes a tag from the customer in the event (nothing happens if absent).",
    inputSchema: strict({ tag: tagNameSchema }),
    requiredPermission: "tag_customers",
    target: "customer",
  },
  assign_conversation: {
    name: "assign_conversation",
    label: "Assign conversation",
    description: "Assigns the conversation in the event to an organization member.",
    inputSchema: strict({ assigneeId: z.uuid() }),
    requiredPermission: "assign_conversations",
    target: "conversation",
    memberFields: ["assigneeId"],
  },
  change_conversation_status: {
    name: "change_conversation_status",
    label: "Change conversation status",
    description: "Moves the conversation in the event to another status.",
    inputSchema: strict({ status: z.enum(CONVERSATION_STATUSES) }),
    requiredPermission: "update_conversations",
    target: "conversation",
  },
  change_conversation_priority: {
    name: "change_conversation_priority",
    label: "Change conversation priority",
    description: "Sets the priority of the conversation in the event.",
    inputSchema: strict({ priority: z.enum(CONVERSATION_PRIORITIES) }),
    requiredPermission: "update_conversations",
    target: "conversation",
  },
  create_customer_note: {
    name: "create_customer_note",
    label: "Add note to customer",
    description: "Adds an internal note to the customer in the event.",
    inputSchema: strict({ content: z.string().trim().min(1).max(2000) }),
    requiredPermission: "add_customer_notes",
    target: "customer",
  },
};

export function isTriggerName(value: string): value is TriggerName {
  return (TRIGGER_NAMES as readonly string[]).includes(value);
}
export function isActionName(value: string): value is ActionName {
  return (ACTION_NAMES as readonly string[]).includes(value);
}
