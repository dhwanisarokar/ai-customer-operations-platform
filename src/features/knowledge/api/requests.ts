import type { ListDocumentsQuery } from "../schemas";

export function knowledgeListUrl(query: ListDocumentsQuery): string {
  const search = new URLSearchParams();
  search.set("page", String(query.page));
  search.set("pageSize", String(query.pageSize));
  if (query.q) search.set("q", query.q);
  if (query.status?.length) search.set("status", query.status.join(","));
  search.set("sort", query.sort);
  search.set("order", query.order);
  return `/api/knowledge?${search.toString()}`;
}
