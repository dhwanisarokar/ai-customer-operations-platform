import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { STALE_TIME } from "@/lib/query/query-client";
import { conversationsKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import { conversationsListUrl } from "../api/requests";
import {
  DEFAULT_EVENTS_PARAMS,
  type ConversationDetailResponse,
  type ConversationEventsResponse,
  type ConversationListResponse,
  type EventsParams,
  type MessagesParams,
  type MessagesResponse,
} from "../api/types";
import type { ListConversationsQuery } from "../schemas";

type Options<T> = { initialData?: T; enabled?: boolean };

/** The inbox list. Filters, search, sort and page are part of the key; the old page stays visible while a new one loads. */
export function useConversations(
  query: ListConversationsQuery,
  options: Options<ConversationListResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: conversationsKeys.list(org, query),
    queryFn: ({ signal }) =>
      fetchJson<ConversationListResponse>(conversationsListUrl(query), { signal }),
    staleTime: STALE_TIME.conversations,
    placeholderData: keepPreviousData,
    ...options,
  });
}

/** One conversation. Short stale time: agents expect a current status/assignee when they open it. */
export function useConversation(
  conversationId: string,
  options: Options<ConversationDetailResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: conversationsKeys.detail(org, conversationId),
    queryFn: ({ signal }) =>
      fetchJson<ConversationDetailResponse>(`/api/conversations/${conversationId}`, { signal }),
    staleTime: STALE_TIME.conversations,
    ...options,
  });
}

/**
 * The newest `limit` messages, chronological. `includeInternal` is part of the key: customer-facing
 * history and the staff view (with internal notes) are different cache entries and are never mixed.
 */
export function useConversationMessages(
  conversationId: string,
  params: MessagesParams,
  options: Options<MessagesResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: conversationsKeys.messages(org, conversationId, params),
    queryFn: ({ signal }) =>
      fetchJson<MessagesResponse>(
        `/api/conversations/${conversationId}/messages?limit=${params.limit}&includeInternal=${params.includeInternal}`,
        { signal },
      ),
    staleTime: STALE_TIME.messages,
    placeholderData: keepPreviousData,
    ...options,
  });
}

/** Audit events, newest first. */
export function useConversationEvents(
  conversationId: string,
  params: EventsParams = DEFAULT_EVENTS_PARAMS,
  options: Options<ConversationEventsResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: conversationsKeys.events(org, conversationId, params),
    queryFn: ({ signal }) =>
      fetchJson<ConversationEventsResponse>(
        `/api/conversations/${conversationId}/events?page=${params.page}&pageSize=${params.pageSize}`,
        { signal },
      ),
    staleTime: STALE_TIME.messages,
    ...options,
  });
}
