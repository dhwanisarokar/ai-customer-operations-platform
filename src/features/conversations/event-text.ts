const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
};

const PRIORITY_LABEL: Record<string, string> = {
  LOW: "Low",
  NORMAL: "Normal",
  HIGH: "High",
  URGENT: "Urgent",
};

export const statusLabel = (status: string) => STATUS_LABEL[status] ?? status;
export const priorityLabel = (priority: string) => PRIORITY_LABEL[priority] ?? priority;

export type TimelineEvent = {
  type: string;
  metadata: unknown;
  actorType: string;
  actorId: string | null;
};

/** Event types that are shown as their own message bubble instead of a system line. */
export const MESSAGE_EVENT_TYPES = new Set(["MESSAGE_SENT", "INTERNAL_NOTE_ADDED"]);

/**
 * Human-readable text for an audit event. `names` maps user ids to display names; unknown ids
 * (for example a removed member) degrade to a generic wording instead of failing.
 */
export function describeEvent(event: TimelineEvent, names: ReadonlyMap<string, string>): string {
  const meta = (event.metadata ?? {}) as Record<string, string | null | undefined>;
  const actor =
    event.actorType === "SYSTEM"
      ? "System"
      : event.actorType === "AI"
        ? "AI agent"
        : ((event.actorId && names.get(event.actorId)) ?? "A team member");
  const who = (id: string | null | undefined) =>
    id ? (names.get(id) ?? "a former member") : "nobody";

  switch (event.type) {
    case "CONVERSATION_CREATED":
      return `${actor} created the conversation`;
    case "SUBJECT_CHANGED":
      return `${actor} changed the subject to "${meta.to ?? ""}"`;
    case "STATUS_CHANGED": {
      const base = `${actor} changed the status from ${statusLabel(meta.from ?? "")} to ${statusLabel(meta.to ?? "")}`;
      return meta.reason === "customer_message" ? `${base} (customer replied)` : base;
    }
    case "PRIORITY_CHANGED":
      return `${actor} changed the priority from ${priorityLabel(meta.from ?? "")} to ${priorityLabel(meta.to ?? "")}`;
    case "ASSIGNED":
      return meta.from
        ? `${actor} reassigned the conversation from ${who(meta.from)} to ${who(meta.to)}`
        : `${actor} assigned the conversation to ${who(meta.to)}`;
    case "UNASSIGNED":
      return meta.reason === "member_removed"
        ? `Unassigned from ${who(meta.from)} (left the organization)`
        : `${actor} unassigned the conversation from ${who(meta.from)}`;
    default:
      return `${actor} updated the conversation`;
  }
}
