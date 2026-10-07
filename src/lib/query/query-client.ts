import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";

/**
 * How long fetched data counts as fresh (no background refetch while fresh). Chosen per kind of
 * data, not globally. There is no real-time channel yet, so "fresh" means "recently fetched":
 *
 * - conversations / messages: short, because support agents expect current inboxes and threads
 *   (they also refetch on window focus once stale);
 * - customers: moderate, they change on human timescales;
 * - tags and members: longer, they rarely change;
 * - knowledge: longest, articles change rarely and editing is explicit.
 */
export const STALE_TIME = {
  conversations: 15_000,
  messages: 10_000,
  customers: 60_000,
  tags: 2 * 60_000,
  members: 5 * 60_000,
  knowledge: 5 * 60_000,
} as const;

/** Unused cached data is kept for 5 minutes so going back to a list/detail is instant. */
const GC_TIME = 5 * 60_000;

/** Retry once for transient failures (network, 5xx); never repeat a request the server rejected. */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.isClientError) return false;
  return failureCount < 1;
}

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME.customers,
        gcTime: GC_TIME,
        retry: shouldRetry,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      // Mutations are never retried automatically: repeating a write (sending a message, asking
      // the AI) must be an explicit user action.
      mutations: { retry: false },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

/**
 * One QueryClient per browser tab. On the server a new client is created per call, so cached data
 * is never shared between users or requests.
 */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}
