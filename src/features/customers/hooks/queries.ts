import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { STALE_TIME } from "@/lib/query/query-client";
import { customersKeys, tagsKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import type {
  Customer360Response,
  CustomerActivitiesResponse,
  CustomerListResponse,
  CustomerNotesResponse,
  CustomerTagsResponse,
  OrganizationTagsResponse,
} from "../api/types";
import {
  DEFAULT_ACTIVITIES_PARAMS,
  DEFAULT_NOTES_PARAMS,
  customersListUrl,
  pagedUrl,
} from "../api/requests";
import type { ListCustomersQuery } from "../schemas";

type Options<T> = { initialData?: T; enabled?: boolean };

/**
 * Server-paginated, server-filtered customer list. Page, filters, search and sort are part of the
 * key, so each view has its own cache entry; the previous page stays visible while the next loads.
 */
export function useCustomers(
  query: ListCustomersQuery,
  options: Options<CustomerListResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: customersKeys.list(org, query),
    queryFn: ({ signal }) => fetchJson<CustomerListResponse>(customersListUrl(query), { signal }),
    staleTime: STALE_TIME.customers,
    placeholderData: keepPreviousData,
    ...options,
  });
}

/** Customer 360: the customer plus tags, recent activity, notes and conversations. */
export function useCustomer(customerId: string, options: Options<Customer360Response> = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: customersKeys.detail(org, customerId),
    queryFn: ({ signal }) =>
      fetchJson<Customer360Response>(`/api/customers/${customerId}`, { signal }),
    staleTime: STALE_TIME.customers,
    ...options,
  });
}

export function useCustomerActivities(
  customerId: string,
  params: { page: number; pageSize: number } = DEFAULT_ACTIVITIES_PARAMS,
  options: Options<CustomerActivitiesResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: customersKeys.activities(org, customerId, params),
    queryFn: ({ signal }) =>
      fetchJson<CustomerActivitiesResponse>(
        pagedUrl(`/api/customers/${customerId}/activities`, params),
        { signal },
      ),
    staleTime: STALE_TIME.customers,
    ...options,
  });
}

export function useCustomerNotes(
  customerId: string,
  params: { page: number; pageSize: number } = DEFAULT_NOTES_PARAMS,
  options: Options<CustomerNotesResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: customersKeys.notes(org, customerId, params),
    queryFn: ({ signal }) =>
      fetchJson<CustomerNotesResponse>(pagedUrl(`/api/customers/${customerId}/notes`, params), {
        signal,
      }),
    staleTime: STALE_TIME.customers,
    ...options,
  });
}

export function useCustomerTags(customerId: string, options: Options<CustomerTagsResponse> = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: customersKeys.tags(org, customerId),
    queryFn: ({ signal }) =>
      fetchJson<CustomerTagsResponse>(`/api/customers/${customerId}/tags`, { signal }),
    staleTime: STALE_TIME.tags,
    ...options,
  });
}

/** The organization's tag catalogue (suggestions when tagging). */
export function useOrganizationTags(options: Options<OrganizationTagsResponse> = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: tagsKeys.list(org),
    queryFn: ({ signal }) => fetchJson<OrganizationTagsResponse>("/api/tags", { signal }),
    staleTime: STALE_TIME.tags,
    ...options,
  });
}
