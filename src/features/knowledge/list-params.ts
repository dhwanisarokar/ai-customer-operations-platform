import { listDocumentsQuerySchema, type ListDocumentsQuery } from "./schemas";

/** Validates list-page URL params; invalid input falls back to defaults and reports it. */
export function parseKnowledgeListParams(params: Record<string, string>): {
  query: ListDocumentsQuery;
  invalid: boolean;
} {
  const parsed = listDocumentsQuerySchema.safeParse(params);
  if (parsed.success) return { query: parsed.data, invalid: false };
  return { query: listDocumentsQuerySchema.parse({}), invalid: true };
}

/** Builds a /dashboard/knowledge URL from current params plus overrides (undefined removes). */
export function knowledgeHref(
  current: Record<string, string>,
  patch: Record<string, string | undefined>,
): string {
  const next = { ...current, ...patch };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined || value === "" || (key === "page" && value === "1")) continue;
    search.set(key, value);
  }
  const qs = search.toString();
  return qs ? `/dashboard/knowledge?${qs}` : "/dashboard/knowledge";
}
