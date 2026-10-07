import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { customersKeys, conversationsKeys, mutationKeys, type OrgId } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import {
  isLastPendingMutation,
  prepareOptimisticUpdate,
  restoreSnapshot,
  type CacheSnapshot,
} from "@/lib/query/optimistic";
import { useOutbox } from "@/lib/query/outbox";
import type {
  ConversationDetailResponse,
  ConversationJson,
  ConversationListResponse,
  MessageJson,
  MessagesParams,
  MessagesResponse,
  SendMessageInput,
} from "../api/types";
import type { ConversationPriority, ConversationStatus } from "../schemas";

type Context = { snapshot: CacheSnapshot } | undefined;

function patchConversationCaches(
  queryClient: QueryClient,
  org: OrgId,
  conversationId: string,
  patch: (current: ConversationJson) => Partial<ConversationJson>,
) {
  queryClient.setQueryData<ConversationDetailResponse>(
    conversationsKeys.detail(org, conversationId),
    (old) => old && { conversation: { ...old.conversation, ...patch(old.conversation) } },
  );
  queryClient.setQueriesData<ConversationListResponse>(
    { queryKey: conversationsKeys.lists(org) },
    (old) =>
      old && {
        ...old,
        items: old.items.map((item) =>
          item.id === conversationId ? { ...item, ...patch(item) } : item,
        ),
      },
  );
}

type PatchMutationOptions<TVars extends { conversationId: string }> = {
  action: string;
  request: (vars: TVars) => Promise<{ conversation?: ConversationJson } | null>;
  /** The optimistic change, applied to the detail view and to every cached inbox list. */
  patch: (vars: TVars, current: ConversationJson) => Partial<ConversationJson>;
  /**
   * When to refetch the authoritative state: "always", or only "on-error" when the optimistic value
   * is exactly what the server will hold (marking as read) and a refetch would be wasted traffic.
   */
  reconcile: "always" | "on-error";
};

/**
 * The shared optimistic lifecycle for small, predictable, reversible conversation changes:
 *
 *   onMutate   cancel in-flight fetches, snapshot, apply the change to detail + all cached lists
 *   onError    restore the snapshot (the UI shows `mutation.error`)
 *   onSuccess  store the server's conversation as the detail value
 *   onSettled  refetch (detail, lists, events) so the server has the final word, which also
 *              resolves races with other agents' changes
 */
function useOptimisticConversationMutation<TVars extends { conversationId: string }>(
  options: PatchMutationOptions<TVars>,
) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  const mutationKey = [...conversationsKeys.all(org), "mutation", options.action] as const;

  return useMutation({
    mutationKey,
    mutationFn: options.request,

    onMutate: async (vars: TVars) => {
      const snapshot = await prepareOptimisticUpdate(queryClient, [
        { queryKey: conversationsKeys.detail(org, vars.conversationId) },
        { queryKey: conversationsKeys.lists(org) },
      ]);
      patchConversationCaches(queryClient, org, vars.conversationId, (current) =>
        options.patch(vars, current),
      );
      return { snapshot } satisfies Context;
    },

    onError: (_error, _vars, context) => restoreSnapshot(queryClient, context?.snapshot),

    onSuccess: (data, vars) => {
      if (data?.conversation) {
        queryClient.setQueryData<ConversationDetailResponse>(
          conversationsKeys.detail(org, vars.conversationId),
          { conversation: data.conversation },
        );
      }
    },

    onSettled: async (_data, error, vars) => {
      if (options.reconcile === "on-error" && !error) return;
      if (!isLastPendingMutation(queryClient, mutationKey)) return;
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationsKeys.detail(org, vars.conversationId),
        }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) }),
        queryClient.invalidateQueries({
          queryKey: [...conversationsKeys.item(org, vars.conversationId), "events"],
        }),
      ]);
    },
  });
}

const patchConversation = (conversationId: string, body: Record<string, string>) =>
  fetchJson<{ conversation: ConversationJson }>(`/api/conversations/${conversationId}`, {
    method: "PATCH",
    body,
  });

export function useChangeConversationStatus() {
  return useOptimisticConversationMutation({
    action: "status",
    reconcile: "always",
    request: ({ conversationId, status }: { conversationId: string; status: ConversationStatus }) =>
      patchConversation(conversationId, { status }),
    // closedAt is a placeholder until the server's value arrives; it is not displayed.
    patch: ({ status }, current) => ({
      status,
      closedAt: status === "RESOLVED" ? (current.closedAt ?? new Date().toISOString()) : null,
    }),
  });
}

export function useChangeConversationPriority() {
  return useOptimisticConversationMutation({
    action: "priority",
    reconcile: "always",
    request: ({
      conversationId,
      priority,
    }: {
      conversationId: string;
      priority: ConversationPriority;
    }) => patchConversation(conversationId, { priority }),
    patch: ({ priority }) => ({ priority }),
  });
}

export type Assignee = { id: string; name: string | null; email: string };

export function useAssignConversation() {
  return useOptimisticConversationMutation({
    action: "assign",
    reconcile: "always",
    request: ({ conversationId, assignee }: { conversationId: string; assignee: Assignee }) =>
      fetchJson<{ conversation: ConversationJson }>(`/api/conversations/${conversationId}/assign`, {
        method: "POST",
        body: { userId: assignee.id },
      }),
    patch: ({ assignee }) => ({ assignee }),
  });
}

export function useUnassignConversation() {
  return useOptimisticConversationMutation({
    action: "unassign",
    reconcile: "always",
    request: ({ conversationId }: { conversationId: string }) =>
      fetchJson<{ conversation: ConversationJson }>(
        `/api/conversations/${conversationId}/unassign`,
        { method: "POST" },
      ),
    patch: () => ({ assignee: null }),
  });
}

/** The unread dot clears immediately. The server will hold exactly that, so no refetch on success. */
export function useMarkConversationRead() {
  return useOptimisticConversationMutation({
    action: "read",
    reconcile: "on-error",
    request: ({ conversationId }: { conversationId: string }) =>
      fetchJson<null>(`/api/conversations/${conversationId}/read`, { method: "POST" }),
    patch: () => ({ unread: false }),
  });
}

type CreateConversationVariables = {
  customerId: string;
  subject: string;
  priority: ConversationPriority;
  initialMessage?: { body: string; from: "CUSTOMER" | "USER" };
};

/** Not optimistic: the new conversation needs its server-assigned id. */
export function useCreateConversation() {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: (vars: CreateConversationVariables) =>
      fetchJson<{ conversation: { id: string } }>("/api/conversations", {
        method: "POST",
        body: vars,
      }),
    onSuccess: (_data, vars) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) }),
        // Customer 360 lists the customer's conversations.
        queryClient.invalidateQueries({ queryKey: customersKeys.detail(org, vars.customerId) }),
      ]),
  });
}

/**
 * Sends a message or internal note. On success the server's message is appended to the cached
 * history (the staff view includes notes; the customer-facing view does not), then everything it
 * touches (history, conversation preview/unread, lists, audit events) is refetched.
 *
 * "Optimistic" display of the message while it is in flight is the outbox's job (useMessageOutbox):
 * the cache only ever holds messages the server has accepted.
 */
export function useSendMessage(conversationId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();

  return useMutation({
    mutationKey: mutationKeys.conversation(org, conversationId, "send-message"),
    mutationFn: (input: SendMessageInput) =>
      fetchJson<{ message: MessageJson }>(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        body: input,
      }),

    onSuccess: ({ message }) => {
      for (const query of queryClient
        .getQueryCache()
        .findAll({ queryKey: conversationsKeys.messagesAll(org, conversationId) })) {
        const params = query.queryKey[query.queryKey.length - 1] as MessagesParams;
        if (message.messageType === "INTERNAL_NOTE" && !params.includeInternal) continue;
        queryClient.setQueryData<MessagesResponse>(query.queryKey, (old) =>
          old && !old.items.some((item) => item.id === message.id)
            ? { ...old, items: [...old.items, message], total: old.total + 1 }
            : old,
        );
      }
    },

    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationsKeys.messagesAll(org, conversationId),
        }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.detail(org, conversationId) }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) }),
        queryClient.invalidateQueries({
          queryKey: [...conversationsKeys.item(org, conversationId), "events"],
        }),
      ]),
  });
}

/**
 * Message/note submission with an outbox: what the user typed shows up immediately as "sending",
 * becomes the real server message on success, or stays as "failed" with retry/discard.
 */
export function useMessageOutbox(conversationId: string) {
  const { mutateAsync } = useSendMessage(conversationId);
  return useOutbox<SendMessageInput>(mutateAsync);
}

/**
 * Asks the server-side AI agent for a reply. This is deliberately NOT optimistic and NOT a cached
 * query: nothing is shown until the server has produced and stored a real AI_AGENT message. While
 * it runs, `isPending` (and `useIsMutating` on the same key) drive the "Generating..." state.
 */
export function useAiReply(conversationId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();

  return useMutation({
    mutationKey: mutationKeys.aiReply(org, conversationId),
    mutationFn: () =>
      fetchJson<{ message: MessageJson }>(`/api/conversations/${conversationId}/ai-reply`, {
        method: "POST",
      }),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationsKeys.messagesAll(org, conversationId),
        }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.detail(org, conversationId) }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) }),
        queryClient.invalidateQueries({
          queryKey: [...conversationsKeys.item(org, conversationId), "events"],
        }),
      ]),
  });
}
