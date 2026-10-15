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
  AiDraftResponse,
  ApprovalActionResponse,
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
      if (!error) scheduleAutomationFollowUps(queryClient, org, vars.conversationId);
    },
  });
}

/**
 * Status, priority and assignment changes can start automations. The server answers the request as
 * soon as the change is saved and the run is queued; the worker applies its actions a moment later
 * (tags, assignment, status...). There is no push channel, so the conversation is refreshed a few
 * more times, shortly after, and then left alone. Active queries only; nothing runs after that.
 */
export const AUTOMATION_FOLLOW_UP_DELAYS_MS = [1_500, 4_000, 8_000] as const;

function scheduleAutomationFollowUps(queryClient: QueryClient, org: OrgId, conversationId: string) {
  if (typeof window === "undefined") return;
  for (const delay of AUTOMATION_FOLLOW_UP_DELAYS_MS) {
    window.setTimeout(() => void refreshConversation(queryClient, org, conversationId), delay);
  }
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

/**
 * Switch who answers a web chat conversation (AI / HUMAN). Not optimistic: enabling AI can be refused
 * (organization setting, channel), so the server's conversation becomes the cached value. The events
 * timeline records the change, so it is refetched too.
 */
export function useSetHandlingMode() {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: ({ conversationId, mode }: { conversationId: string; mode: "AI" | "HUMAN" }) =>
      fetchJson<{ conversation: ConversationJson }>(
        `/api/conversations/${conversationId}/handling`,
        { method: "POST", body: { mode } },
      ),
    onSuccess: (data, { conversationId }) => {
      patchConversationCaches(queryClient, org, conversationId, () => data.conversation);
      void queryClient.invalidateQueries({ queryKey: conversationsKeys.item(org, conversationId) });
      void queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) });
    },
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
/** Adds a server-accepted message to every cached messages window it belongs in (idempotent by id). */
function appendMessageToCache(
  queryClient: QueryClient,
  org: OrgId,
  conversationId: string,
  message: MessageJson,
) {
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
}

function refreshConversation(queryClient: QueryClient, org: OrgId, conversationId: string) {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: conversationsKeys.messagesAll(org, conversationId) }),
    queryClient.invalidateQueries({ queryKey: conversationsKeys.detail(org, conversationId) }),
    queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) }),
    queryClient.invalidateQueries({
      queryKey: [...conversationsKeys.item(org, conversationId), "events"],
    }),
  ]);
}

export function useSendMessage(conversationId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();

  return useMutation({
    mutationKey: mutationKeys.conversation(org, conversationId, "send-message"),
    mutationFn: async (input: SendMessageInput): Promise<{ message: MessageJson }> => {
      if (input.viaEmail) {
        // The email path sends ONLY the text and the idempotency key; the server decides recipient and sender.
        const result = await fetchJson<{
          message: MessageJson;
          delivery: MessageJson["emailDelivery"];
        }>(`/api/conversations/${conversationId}/email-reply`, {
          method: "POST",
          body: { body: input.body, clientMessageId: input.clientMessageId },
        });
        return { message: { ...result.message, emailDelivery: result.delivery } };
      }
      // Only what the plain endpoint accepts (its schema is strict).
      const plain = { body: input.body, type: input.type, from: input.from };
      return fetchJson<{ message: MessageJson }>(`/api/conversations/${conversationId}/messages`, {
        method: "POST",
        body: plain,
      });
    },

    onSuccess: ({ message }) => appendMessageToCache(queryClient, org, conversationId, message),

    // Not returned on purpose: returning the promise would keep the mutation "pending" until the
    // refetch finished, leaving the pending UI visible next to the already-stored real message.
    onSettled: () => void refreshConversation(queryClient, org, conversationId),
  });
}

/**
 * Message/note submission with an outbox: what the user typed shows up immediately as "sending",
 * becomes the real server message on success, or stays as "failed" with retry/discard.
 */
export function useMessageOutbox(conversationId: string) {
  const { mutateAsync } = useSendMessage(conversationId);
  // Reconcile by the server-assigned message id (never by text): see useOutbox.
  return useOutbox<SendMessageInput, { message: MessageJson }>(
    mutateAsync,
    (result) => result.message.id,
  );
}

/**
 * Asks the server-side AI agent for a suggested reply. The result is a DRAFT for a person to review:
 * the endpoint stores nothing, so there is nothing to put in or invalidate from the cache. Sending
 * the (possibly edited) draft goes through the normal message outbox. `isPending` drives the
 * "Generating..." state; it is UI state, never a message.
 */
export function useAiDraft(conversationId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();

  return useMutation({
    mutationKey: mutationKeys.aiDraft(org, conversationId),
    mutationFn: () =>
      fetchJson<AiDraftResponse>(`/api/conversations/${conversationId}/ai-draft`, {
        method: "POST",
      }),
    // The draft itself stores nothing. Only when the AI asked for changes is there new server state
    // (pending approvals) to show.
    onSuccess: (draft) => {
      if (draft.approvals.length > 0) {
        void queryClient.invalidateQueries({
          queryKey: conversationsKeys.approvals(org, conversationId),
        });
      }
    },
  });
}

/**
 * Approve or reject a pending AI action. NOT optimistic: the change is executed by the server (and
 * can be refused: expired, already handled, no permission), so the UI waits for the real result.
 * Afterwards everything an executed change can touch is refetched.
 */
export function useDecideApproval(conversationId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();

  return useMutation({
    mutationFn: ({ approvalId, action }: { approvalId: string; action: "approve" | "reject" }) =>
      fetchJson<ApprovalActionResponse>(`/api/ai-approvals/${approvalId}/${action}`, {
        method: "POST",
      }),
    onSettled: () => {
      void Promise.all([
        queryClient.invalidateQueries({
          queryKey: conversationsKeys.approvals(org, conversationId),
        }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.detail(org, conversationId) }),
        queryClient.invalidateQueries({ queryKey: conversationsKeys.lists(org) }),
        queryClient.invalidateQueries({
          queryKey: [...conversationsKeys.item(org, conversationId), "events"],
        }),
        // An approved updateCustomer changes customer data shown elsewhere.
        queryClient.invalidateQueries({ queryKey: customersKeys.all(org) }),
      ]);
    },
  });
}
