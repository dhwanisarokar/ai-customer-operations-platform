/**
 * Query key factories. Conventions (see docs/server-state.md):
 *
 * - Every key starts with ["org", organizationId]: cached data is namespaced per organization.
 * - Keys are hierarchical, so a prefix invalidates a whole family:
 *     customersKeys.lists(org)        every customer list (any filter/page)
 *     customersKeys.item(org, id)     everything about one customer
 * - Parameters that change the result (filters, search, page, sort, limit) are part of the key,
 *   so different views never share a cache entry.
 * - The organization id only namespaces the cache. It never authorizes anything.
 */
export type OrgId = string | null;

const scope = (org: OrgId) => ["org", org ?? "none"] as const;

export const customersKeys = {
  all: (org: OrgId) => [...scope(org), "customers"] as const,
  lists: (org: OrgId) => [...customersKeys.all(org), "list"] as const,
  list: (org: OrgId, params: object) => [...customersKeys.lists(org), params] as const,
  item: (org: OrgId, id: string) => [...customersKeys.all(org), "item", id] as const,
  detail: (org: OrgId, id: string) => [...customersKeys.item(org, id), "detail"] as const,
  activities: (org: OrgId, id: string, params: object) =>
    [...customersKeys.item(org, id), "activities", params] as const,
  notes: (org: OrgId, id: string, params: object) =>
    [...customersKeys.item(org, id), "notes", params] as const,
  tags: (org: OrgId, id: string) => [...customersKeys.item(org, id), "tags"] as const,
};

export const tagsKeys = {
  all: (org: OrgId) => [...scope(org), "tags"] as const,
  list: (org: OrgId) => [...tagsKeys.all(org), "list"] as const,
};

export const membersKeys = {
  list: (org: OrgId) => [...scope(org), "members", "list"] as const,
};

export const conversationsKeys = {
  all: (org: OrgId) => [...scope(org), "conversations"] as const,
  lists: (org: OrgId) => [...conversationsKeys.all(org), "list"] as const,
  list: (org: OrgId, params: object) => [...conversationsKeys.lists(org), params] as const,
  item: (org: OrgId, id: string) => [...conversationsKeys.all(org), "item", id] as const,
  detail: (org: OrgId, id: string) => [...conversationsKeys.item(org, id), "detail"] as const,
  messages: (org: OrgId, id: string, params: object) =>
    [...conversationsKeys.item(org, id), "messages", params] as const,
  /** Prefix for every messages query of one conversation (any limit / visibility). */
  messagesAll: (org: OrgId, id: string) =>
    [...conversationsKeys.item(org, id), "messages"] as const,
  events: (org: OrgId, id: string, params: object) =>
    [...conversationsKeys.item(org, id), "events", params] as const,
  /** Pending AI actions of one conversation. */
  approvals: (org: OrgId, id: string) => [...conversationsKeys.item(org, id), "approvals"] as const,
};

export const widgetKeys = {
  settings: (org: OrgId) => [...scope(org), "widget", "settings"] as const,
};

export const automationsKeys = {
  all: (org: OrgId) => [...scope(org), "automations"] as const,
  lists: (org: OrgId) => [...automationsKeys.all(org), "list"] as const,
  list: (org: OrgId, params: object) => [...automationsKeys.lists(org), params] as const,
  detail: (org: OrgId, id: string) => [...automationsKeys.all(org), "detail", id] as const,
  executions: (org: OrgId, id: string, params: object) =>
    [...automationsKeys.all(org), "executions", id, params] as const,
  executionsAll: (org: OrgId, id: string) =>
    [...automationsKeys.all(org), "executions", id] as const,
  execution: (org: OrgId, id: string, executionId: string) =>
    [...automationsKeys.all(org), "execution", id, executionId] as const,
};

export const knowledgeKeys = {
  all: (org: OrgId) => [...scope(org), "knowledge"] as const,
  lists: (org: OrgId) => [...knowledgeKeys.all(org), "list"] as const,
  list: (org: OrgId, params: object) => [...knowledgeKeys.lists(org), params] as const,
  detail: (org: OrgId, id: string) => [...knowledgeKeys.all(org), "detail", id] as const,
};

/**
 * Mutation keys. They let the UI observe in-flight work (for example "an AI reply is being
 * generated for this conversation") and let optimistic mutations coordinate.
 */
export const mutationKeys = {
  conversation: (org: OrgId, id: string, action: string) =>
    [...conversationsKeys.item(org, id), "mutation", action] as const,
  customerTags: (org: OrgId, id: string) =>
    [...customersKeys.item(org, id), "mutation", "tags"] as const,
  aiDraft: (org: OrgId, id: string) => mutationKeys.conversation(org, id, "ai-draft"),
  approval: (org: OrgId, approvalId: string, action: "approve" | "reject") =>
    [...scope(org), "ai-approvals", approvalId, "mutation", action] as const,
};
