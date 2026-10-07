import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import {
  isLastPendingMutation,
  prepareOptimisticUpdate,
  restoreSnapshot,
  type CacheSnapshot,
} from "@/lib/query/optimistic";
import { customersKeys, tagsKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import type {
  Customer360Response,
  CustomerFormValues,
  CustomerListResponse,
  CustomerTagsResponse,
} from "../api/types";
import type { ListCustomersQuery } from "../schemas";

type Created = { customer: { id: string } };
type Context = { snapshot: CacheSnapshot } | undefined;

export function useCreateCustomer() {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: (values: CustomerFormValues) =>
      fetchJson<Created>("/api/customers", { method: "POST", body: values }),
    // A new customer can appear in any list.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: customersKeys.lists(org) }),
  });
}

/** Not optimistic: it is a validated form submit. The cache is refreshed from the server. */
export function useUpdateCustomer(customerId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: (values: CustomerFormValues) =>
      fetchJson<{ customer: unknown }>(`/api/customers/${customerId}`, {
        method: "PATCH",
        body: values,
      }),
    onSuccess: () =>
      Promise.all([
        // Name/company/status appear in lists; detail, activity and conversations hang off the item.
        queryClient.invalidateQueries({ queryKey: customersKeys.lists(org) }),
        queryClient.invalidateQueries({ queryKey: customersKeys.item(org, customerId) }),
      ]),
  });
}

/**
 * Archive with optimistic UI: the customer leaves every list that hides archived customers
 * (or turns ARCHIVED in lists that show them) and the detail view flips to ARCHIVED immediately.
 * On failure everything is restored; afterwards the server's state is refetched.
 */
export function useArchiveCustomer() {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  const mutationKey = [...customersKeys.all(org), "mutation", "archive"] as const;

  return useMutation({
    mutationKey,
    mutationFn: ({ customerId }: { customerId: string }) =>
      fetchJson<null>(`/api/customers/${customerId}`, { method: "DELETE" }),

    onMutate: async ({ customerId }) => {
      const snapshot = await prepareOptimisticUpdate(queryClient, [
        { queryKey: customersKeys.lists(org) },
        { queryKey: customersKeys.detail(org, customerId) },
      ]);

      for (const query of queryClient
        .getQueryCache()
        .findAll({ queryKey: customersKeys.lists(org) })) {
        // The last element of a list key is the parsed query (see customersKeys.list).
        const params = query.queryKey[query.queryKey.length - 1] as ListCustomersQuery;
        const showsArchived =
          params.includeArchived === true || params.status?.includes("ARCHIVED") === true;
        queryClient.setQueryData<CustomerListResponse>(query.queryKey, (old) => {
          if (!old) return old;
          return showsArchived
            ? {
                ...old,
                items: old.items.map((item) =>
                  item.id === customerId ? { ...item, status: "ARCHIVED" as const } : item,
                ),
              }
            : {
                ...old,
                items: old.items.filter((item) => item.id !== customerId),
                total: Math.max(0, old.total - 1),
              };
        });
      }
      queryClient.setQueryData<Customer360Response>(
        customersKeys.detail(org, customerId),
        (old) => old && { ...old, customer: { ...old.customer, status: "ARCHIVED" as const } },
      );
      return { snapshot } satisfies Context;
    },

    onError: (_error, _vars, context) => restoreSnapshot(queryClient, context?.snapshot),

    onSettled: async (_data, _error, { customerId }) => {
      if (!isLastPendingMutation(queryClient, mutationKey)) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: customersKeys.lists(org) }),
        queryClient.invalidateQueries({ queryKey: customersKeys.item(org, customerId) }),
      ]);
    },
  });
}

type TagAddition = { name: string; tagId?: string };

const PENDING_TAG_PREFIX = "pending:";

function refreshAfterTagChange(
  queryClient: ReturnType<typeof useQueryClient>,
  org: string | null,
  customerId: string,
) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: customersKeys.tags(org, customerId) }),
    queryClient.invalidateQueries({ queryKey: customersKeys.detail(org, customerId) }),
    // The catalogue (new tag / usage counts), the list's tags column and the timeline entry.
    queryClient.invalidateQueries({ queryKey: tagsKeys.list(org) }),
    queryClient.invalidateQueries({ queryKey: customersKeys.lists(org) }),
    queryClient.invalidateQueries({
      queryKey: [...customersKeys.item(org, customerId), "activities"],
    }),
  ]);
}

/**
 * Add a tag (existing by id, or find-or-create by name) with optimistic UI. A tag that is new to
 * the organization gets a clearly temporary id ("pending:...") until the server answers with the
 * real one. Failure removes it again.
 */
export function useAddCustomerTag(customerId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  const mutationKey = [...customersKeys.item(org, customerId), "mutation", "add-tag"] as const;
  const tagsKey = customersKeys.tags(org, customerId);

  return useMutation({
    mutationKey,
    mutationFn: (input: TagAddition) =>
      fetchJson<{ tag: { id: string; name: string; createdAt: string } }>(
        `/api/customers/${customerId}/tags`,
        { method: "POST", body: input.tagId ? { tagId: input.tagId } : { name: input.name } },
      ),

    onMutate: async (input) => {
      const snapshot = await prepareOptimisticUpdate(queryClient, [
        { queryKey: tagsKey },
        { queryKey: customersKeys.detail(org, customerId) },
      ]);
      const optimistic = {
        id: input.tagId ?? `${PENDING_TAG_PREFIX}${input.name.toLowerCase()}`,
        name: input.name,
        createdAt: "",
      };
      const addTo = <T extends { id: string; name: string }>(tags: T[]): T[] =>
        tags.some(
          (tag) => tag.id === optimistic.id || tag.name.toLowerCase() === input.name.toLowerCase(),
        )
          ? tags
          : [...tags, optimistic as unknown as T];
      queryClient.setQueryData<CustomerTagsResponse>(
        tagsKey,
        (old) => old && { tags: addTo(old.tags) },
      );
      queryClient.setQueryData<Customer360Response>(
        customersKeys.detail(org, customerId),
        (old) => old && { ...old, tags: addTo(old.tags) },
      );
      return { snapshot } satisfies Context;
    },

    onError: (_error, _vars, context) => restoreSnapshot(queryClient, context?.snapshot),

    onSettled: async () => {
      if (isLastPendingMutation(queryClient, mutationKey)) {
        await refreshAfterTagChange(queryClient, org, customerId);
      }
    },
  });
}

export function useRemoveCustomerTag(customerId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  const mutationKey = [...customersKeys.item(org, customerId), "mutation", "remove-tag"] as const;
  const tagsKey = customersKeys.tags(org, customerId);

  return useMutation({
    mutationKey,
    mutationFn: ({ tagId }: { tagId: string }) =>
      fetchJson<null>(`/api/customers/${customerId}/tags/${tagId}`, { method: "DELETE" }),

    onMutate: async ({ tagId }) => {
      const snapshot = await prepareOptimisticUpdate(queryClient, [
        { queryKey: tagsKey },
        { queryKey: customersKeys.detail(org, customerId) },
      ]);
      queryClient.setQueryData<CustomerTagsResponse>(
        tagsKey,
        (old) => old && { tags: old.tags.filter((tag) => tag.id !== tagId) },
      );
      queryClient.setQueryData<Customer360Response>(
        customersKeys.detail(org, customerId),
        (old) => old && { ...old, tags: old.tags.filter((tag) => tag.id !== tagId) },
      );
      return { snapshot } satisfies Context;
    },

    onError: (_error, _vars, context) => restoreSnapshot(queryClient, context?.snapshot),

    onSettled: async () => {
      if (isLastPendingMutation(queryClient, mutationKey)) {
        await refreshAfterTagChange(queryClient, org, customerId);
      }
    },
  });
}

/**
 * Add a note. The pending note is shown from the component's outbox (see lib/query/outbox.ts), not
 * written into the cache, so no fake id or timestamp ever enters server state. On success the
 * notes, timeline and counts are refetched.
 */
export function useAddCustomerNote(customerId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: ({ content }: { content: string }) =>
      fetchJson<{ note: { id: string } }>(`/api/customers/${customerId}/notes`, {
        method: "POST",
        body: { content },
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: [...customersKeys.item(org, customerId), "notes"],
        }),
        queryClient.invalidateQueries({
          queryKey: [...customersKeys.item(org, customerId), "activities"],
        }),
        queryClient.invalidateQueries({ queryKey: customersKeys.detail(org, customerId) }),
      ]),
  });
}
