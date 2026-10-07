import { DEFAULT_PAGE_SIZE, listCustomersQuerySchema, type ListCustomersQuery } from "./schemas";

export type RawSearchParams = Record<string, string | string[] | undefined>;

/** Flattens Next.js searchParams (string | string[]) to first values, dropping empties. */
export function flattenSearchParams(raw: RawSearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first) out[key] = first;
  }
  return out;
}

/**
 * Translates page-level filter params into the API query contract:
 * - status=ALL means "include archived"
 * - createdFrom/createdTo arrive as YYYY-MM-DD from date inputs (UTC day boundaries)
 */
export function toApiQuery(params: Record<string, string>): Record<string, string> {
  const query: Record<string, string> = { ...params };
  if (query.status === "ALL") {
    delete query.status;
    query.includeArchived = "true";
  }
  if (query.createdFrom && /^\d{4}-\d{2}-\d{2}$/.test(query.createdFrom)) {
    query.createdFrom = `${query.createdFrom}T00:00:00.000Z`;
  }
  if (query.createdTo && /^\d{4}-\d{2}-\d{2}$/.test(query.createdTo)) {
    query.createdTo = `${query.createdTo}T23:59:59.999Z`;
  }
  return query;
}

/** Validates params for the list page; invalid input falls back to defaults and reports it. */
export function parseListParams(params: Record<string, string>): {
  query: ListCustomersQuery;
  invalid: boolean;
} {
  const parsed = listCustomersQuerySchema.safeParse(toApiQuery(params));
  if (parsed.success) return { query: parsed.data, invalid: false };
  return { query: listCustomersQuerySchema.parse({}), invalid: true };
}

/** Builds a /dashboard/customers URL from the current params plus overrides (undefined removes). */
export function customersHref(
  current: Record<string, string>,
  patch: Record<string, string | undefined>,
): string {
  const next = { ...current, ...patch };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === "") continue;
    if (key === "page" && value === "1") continue;
    if (key === "pageSize" && value === String(DEFAULT_PAGE_SIZE)) continue;
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/dashboard/customers?${qs}` : "/dashboard/customers";
}
