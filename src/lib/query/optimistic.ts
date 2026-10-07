import type { QueryClient, QueryFilters, QueryKey } from "@tanstack/react-query";

/** Previous cache contents, captured before an optimistic update so it can be rolled back. */
export type CacheSnapshot = [QueryKey, unknown][];

/**
 * The first half of the optimistic pattern (TanStack's documented lifecycle):
 *   1. cancel in-flight fetches that could overwrite the optimistic value,
 *   2. snapshot the affected cache entries.
 * The caller then applies the optimistic change; `restoreSnapshot` undoes it in `onError`, and
 * `onSettled` invalidates so the server's answer is always the final word.
 */
export async function prepareOptimisticUpdate(
  queryClient: QueryClient,
  filters: QueryFilters[],
): Promise<CacheSnapshot> {
  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)));
  return filters.flatMap((filter) => queryClient.getQueriesData(filter));
}

export function restoreSnapshot(queryClient: QueryClient, snapshot: CacheSnapshot | undefined) {
  for (const [key, data] of snapshot ?? []) queryClient.setQueryData(key, data);
}

/**
 * True when this is the last pending mutation with `mutationKey`. Invalidating while another
 * optimistic mutation of the same entity is still in flight would replace its optimistic value
 * with a stale server read (flicker); the last mutation to settle reconciles for all of them.
 */
export function isLastPendingMutation(queryClient: QueryClient, mutationKey: QueryKey): boolean {
  return queryClient.isMutating({ mutationKey }) <= 1;
}
