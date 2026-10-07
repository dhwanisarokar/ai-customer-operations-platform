import type { ListConversationsQuery } from "../schemas";

/** Serializes a parsed inbox query into the API's query string. Only set values are sent. */
export function conversationsListUrl(query: ListConversationsQuery): string {
  const search = new URLSearchParams();
  search.set("page", String(query.page));
  search.set("pageSize", String(query.pageSize));
  if (query.q) search.set("q", query.q);
  if (query.status?.length) search.set("status", query.status.join(","));
  if (query.priority?.length) search.set("priority", query.priority.join(","));
  if (query.assignee) search.set("assignee", query.assignee);
  if (query.channel) search.set("channel", query.channel);
  if (query.customerId) search.set("customerId", query.customerId);
  search.set("sort", query.sort);
  search.set("order", query.order);
  return `/api/conversations?${search.toString()}`;
}
