import type { TriggerName } from "@/server/automation/catalog";

/**
 * Domain events: facts about something that already happened, emitted by application services after
 * the database change committed. Payloads hold only ids and enum values (plus message text for
 * conditions, which is never stored). The organization comes from the authenticated context of the
 * service that emits, never from a client.
 */
export type EventDataMap = {
  "customer.created": {
    customerId: string;
    status: string;
    company: string | null;
    source: string | null;
  };
  "customer.updated": {
    customerId: string;
    status: string;
    company: string | null;
    changedFields: string[];
  };
  "conversation.created": {
    conversationId: string;
    customerId: string;
    priority: string;
    status: string;
    channel: string;
  };
  "conversation.status_changed": {
    conversationId: string;
    customerId: string;
    status: string;
    previousStatus: string;
    priority: string;
    assignee: string | null;
  };
  "conversation.priority_changed": {
    conversationId: string;
    customerId: string;
    priority: string;
    previousPriority: string;
    status: string;
    assignee: string | null;
  };
  "conversation.assigned": {
    conversationId: string;
    customerId: string;
    assignee: string;
    previousAssignee: string | null;
    status: string;
    priority: string;
  };
  "message.created": {
    messageId: string;
    conversationId: string;
    customerId: string;
    senderType: string;
    messageType: string;
    /** Used by conditions only; dropped before anything is stored. */
    body: string;
  };
  "customer.tag_added": { customerId: string; tagId: string; tagName: string };
  "customer.tag_removed": { customerId: string; tagId: string; tagName: string };
};

export type DomainEvent<T extends TriggerName = TriggerName> = {
  /** Stable identity: replaying the same event can never run an automation twice. */
  id: string;
  type: T;
  organizationId: string;
  occurredAt: string;
  actorUserId: string | null;
  data: EventDataMap[T];
  /** True when an automation's own action caused it; such events never trigger automations. */
  causedByAutomation: boolean;
};
