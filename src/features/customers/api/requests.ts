import type { ListCustomersQuery } from "../schemas";

/** Serializes a parsed list query into the API's query string. Only set values are sent. */
export function customersListUrl(query: ListCustomersQuery): string {
  const search = new URLSearchParams();
  search.set("page", String(query.page));
  search.set("pageSize", String(query.pageSize));
  if (query.q) search.set("q", query.q);
  if (query.status?.length) search.set("status", query.status.join(","));
  if (query.tagIds?.length) search.set("tagIds", query.tagIds.join(","));
  if (query.company) search.set("company", query.company);
  if (query.source) search.set("source", query.source);
  if (query.createdFrom) search.set("createdFrom", query.createdFrom);
  if (query.createdTo) search.set("createdTo", query.createdTo);
  if (query.includeArchived !== undefined)
    search.set("includeArchived", String(query.includeArchived));
  search.set("sort", query.sort);
  search.set("order", query.order);
  return `/api/customers?${search.toString()}`;
}

export const DEFAULT_ACTIVITIES_PARAMS = { page: 1, pageSize: 20 } as const;
export const DEFAULT_NOTES_PARAMS = { page: 1, pageSize: 10 } as const;

export function pagedUrl(base: string, params: { page: number; pageSize: number }): string {
  return `${base}?page=${params.page}&pageSize=${params.pageSize}`;
}
