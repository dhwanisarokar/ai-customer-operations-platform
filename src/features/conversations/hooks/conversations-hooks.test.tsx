// @vitest-environment jsdom
import { useIsMutating } from "@tanstack/react-query";
import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { conversationsKeys, mutationKeys } from "@/lib/query/query-keys";
import {
  TEST_ORG,
  apiError,
  createTestQueryClient,
  deferred,
  json,
  mockApi,
  noContent,
  renderHookWithQuery,
} from "../../../../tests/helpers/query";
import { conversation, conversationList, message } from "../../../../tests/helpers/fixtures";
import type {
  ConversationDetailResponse,
  ConversationListResponse,
  MessagesResponse,
} from "../api/types";
import { listConversationsQuerySchema } from "../schemas";
import {
  AUTOMATION_FOLLOW_UP_DELAYS_MS,
  useAiDraft,
  useAssignConversation,
  useChangeConversationPriority,
  useChangeConversationStatus,
  useCreateConversation,
  useMarkConversationRead,
  useMessageOutbox,
  useUnassignConversation,
} from "./mutations";
import { useConversation, useConversationMessages, useConversations } from "./queries";

afterEach(() => vi.unstubAllGlobals());

const detailKey = conversationsKeys.detail(TEST_ORG, "c1");
const listParams = listConversationsQuerySchema.parse({});
const listKey = conversationsKeys.list(TEST_ORG, listParams);
const dana = { id: "u1", name: "Dana", email: "dana@example.com" };

type Client = ReturnType<typeof createTestQueryClient>;
const detail = (client: Client) =>
  client.getQueryData<ConversationDetailResponse>(detailKey)!.conversation;
const listed = (client: Client) => client.getQueryData<ConversationListResponse>(listKey)!.items[0];

function seed(overrides: Parameters<typeof conversation>[0] = {}) {
  const client = createTestQueryClient();
  client.setQueryData<ConversationDetailResponse>(detailKey, {
    conversation: conversation(overrides),
  });
  client.setQueryData<ConversationListResponse>(
    listKey,
    conversationList([conversation(overrides)]),
  );
  return client;
}

describe("conversation queries", () => {
  it("loads the inbox list with its filters in the URL and key", async () => {
    const api = mockApi({
      "GET /api/conversations": () => json(200, conversationList([conversation()])),
    });
    const q = listConversationsQuerySchema.parse({
      status: "OPEN,PENDING",
      assignee: "me",
      q: "refund",
      sort: "priority",
      order: "asc",
    });
    const { result } = renderHookWithQuery(() => useConversations(q));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const params = Object.fromEntries(new URL(api.calls[0].url, "http://x").searchParams);
    expect(params).toMatchObject({
      status: "OPEN,PENDING",
      assignee: "me",
      q: "refund",
      sort: "priority",
      order: "asc",
    });
  });

  it("reports a missing conversation as an error without retrying", async () => {
    const api = mockApi({
      "GET /api/conversations/c1": () => apiError(404, "not_found", "Conversation not found"),
    });
    const { result } = renderHookWithQuery(() => useConversation("c1"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toMatchObject({ status: 404 });
    expect(api.calls).toHaveLength(1);
  });

  it("keeps customer-facing and staff message history in separate cache entries", async () => {
    const api = mockApi({
      "GET /api/conversations/c1/messages": (url) =>
        json(200, {
          items: [message({ id: url.includes("includeInternal=true") ? "staff" : "public" })],
          hasMore: false,
          nextCursor: null,
          total: 1,
        }),
    });
    const { result } = renderHookWithQuery(() => ({
      staff: useConversationMessages("c1", { limit: 50, includeInternal: true }),
      pub: useConversationMessages("c1", { limit: 50, includeInternal: false }),
    }));
    await waitFor(() =>
      expect(result.current.staff.isSuccess && result.current.pub.isSuccess).toBe(true),
    );
    expect(result.current.staff.data?.items[0].id).toBe("staff");
    expect(result.current.pub.data?.items[0].id).toBe("public");
    expect(api.calls.map((c) => c.url).sort()).toEqual([
      "/api/conversations/c1/messages?limit=50&includeInternal=false",
      "/api/conversations/c1/messages?limit=50&includeInternal=true",
    ]);
  });
});

describe("conversation status (optimistic)", () => {
  it("updates the detail and every cached list immediately, then adopts the server's conversation", async () => {
    const client = seed();
    const gate = deferred<Response>();
    mockApi({ "PATCH /api/conversations/c1": () => gate.promise });
    const { result } = renderHookWithQuery(() => useChangeConversationStatus(), { client });

    act(() => result.current.mutate({ conversationId: "c1", status: "RESOLVED" }));
    await waitFor(() => expect(detail(client).status).toBe("RESOLVED"));
    expect(listed(client).status).toBe("RESOLVED");
    expect(detail(client).closedAt).not.toBeNull();
    expect(result.current.isPending).toBe(true);

    gate.resolve(
      json(200, {
        conversation: conversation({ status: "RESOLVED", closedAt: "2026-01-02T00:00:00.000Z" }),
      }),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(detail(client).closedAt).toBe("2026-01-02T00:00:00.000Z");
  });

  it("restores the old status everywhere and shows the server's error when it is rejected", async () => {
    const client = seed();
    mockApi({
      "PATCH /api/conversations/c1": () =>
        apiError(409, "conflict", "Cannot change status from RESOLVED to PENDING"),
    });
    const { result } = renderHookWithQuery(() => useChangeConversationStatus(), { client });

    act(() => result.current.mutate({ conversationId: "c1", status: "PENDING" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("Cannot change status from RESOLVED to PENDING");
    expect(detail(client).status).toBe("OPEN");
    expect(listed(client).status).toBe("OPEN");
    expect(detail(client).closedAt).toBeNull();
  });

  it("refetches the authoritative detail, lists and events afterwards, resolving races with other agents", async () => {
    const client = seed();
    const api = mockApi({
      // Another agent resolved it meanwhile: the server's answer wins over our optimistic value.
      "PATCH /api/conversations/c1": () =>
        apiError(409, "conflict", "Cannot change status from RESOLVED to PENDING"),
      "GET /api/conversations/c1/events": () =>
        json(200, { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 }),
      "GET /api/conversations/c1": () =>
        json(200, {
          conversation: conversation({ status: "RESOLVED", closedAt: "2026-01-02T00:00:00.000Z" }),
        }),
      "GET /api/conversations?": () =>
        json(200, conversationList([conversation({ status: "RESOLVED" })])),
    });
    const { result } = renderHookWithQuery(
      () => ({
        mutation: useChangeConversationStatus(),
        detail: useConversation("c1"),
        list: useConversations(listParams),
      }),
      { client },
    );
    await waitFor(() => expect(result.current.detail.isFetching).toBe(false));
    api.calls.length = 0;

    act(() => result.current.mutation.mutate({ conversationId: "c1", status: "PENDING" }));
    await waitFor(() => expect(result.current.mutation.isError).toBe(true));
    await waitFor(() => expect(detail(client).status).toBe("RESOLVED"));
    await waitFor(() => expect(listed(client).status).toBe("RESOLVED"));
    expect(api.count("GET", "/api/conversations/c1")).toBe(1);
  });

  it("after a successful change it refreshes the conversation a few more times, so automation side effects appear", async () => {
    const client = seed();
    const api = mockApi({
      "PATCH /api/conversations/c1": () =>
        json(200, { conversation: conversation({ status: "PENDING" }) }),
      "GET /api/conversations/c1/events": () =>
        json(200, { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 }),
      "GET /api/conversations/c1": () =>
        json(200, { conversation: conversation({ status: "PENDING" }) }),
      "GET /api/conversations?": () =>
        json(200, conversationList([conversation({ status: "PENDING" })])),
    });
    // Capture only the follow-up timers; every other timer behaves normally.
    const realSetTimeout = window.setTimeout.bind(window);
    const followUps: { fn: () => void; ms: number }[] = [];
    const spy = vi.spyOn(window, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      if ((AUTOMATION_FOLLOW_UP_DELAYS_MS as readonly number[]).includes(ms as number)) {
        followUps.push({ fn, ms: ms as number });
        return 0;
      }
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof window.setTimeout);

    try {
      const { result } = renderHookWithQuery(
        () => ({ mutation: useChangeConversationStatus(), detail: useConversation("c1") }),
        { client },
      );
      await waitFor(() => expect(result.current.detail.isFetching).toBe(false));
      api.calls.length = 0;

      act(() => result.current.mutation.mutate({ conversationId: "c1", status: "PENDING" }));
      await waitFor(() => expect(result.current.mutation.isSuccess).toBe(true));
      await waitFor(() => expect(followUps).toHaveLength(3));
      await waitFor(() => expect(api.count("GET", "/api/conversations/c1")).toBe(1)); // the normal refetch
      expect(followUps.map((f) => f.ms)).toEqual([1_500, 4_000, 8_000]);

      // Each follow-up refetches the conversation again; nothing else is scheduled.
      for (const [index, followUp] of followUps.entries()) {
        act(() => followUp.fn());
        await waitFor(() => expect(api.count("GET", "/api/conversations/c1")).toBe(index + 2));
      }
      expect(followUps).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });

  it("a rejected change schedules no follow-ups", async () => {
    const client = seed();
    mockApi({ "PATCH /api/conversations/c1": () => apiError(409, "conflict", "no") });
    const delays: unknown[] = [];
    const realSetTimeout = window.setTimeout.bind(window);
    const spy = vi.spyOn(window, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
      ...rest: unknown[]
    ) => {
      delays.push(ms);
      return realSetTimeout(fn, ms, ...rest);
    }) as typeof window.setTimeout);
    try {
      const { result } = renderHookWithQuery(() => useChangeConversationStatus(), { client });
      act(() => result.current.mutate({ conversationId: "c1", status: "PENDING" }));
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(
        delays.some((ms) =>
          (AUTOMATION_FOLLOW_UP_DELAYS_MS as readonly number[]).includes(ms as number),
        ),
      ).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("with two rapid changes only the last one to settle reconciles (no flicker from a stale refetch)", async () => {
    const client = seed();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const queue = [first, second];
    const api = mockApi({
      "PATCH /api/conversations/c1": () => queue.shift()!.promise,
      "GET /api/conversations/c1": () =>
        json(200, { conversation: conversation({ status: "RESOLVED" }) }),
    });
    const { result } = renderHookWithQuery(
      () => ({ m: useChangeConversationStatus(), d: useConversation("c1") }),
      { client },
    );
    await waitFor(() => expect(result.current.d.isFetching).toBe(false));
    api.calls.length = 0;

    act(() => {
      result.current.m.mutate({ conversationId: "c1", status: "PENDING" });
      result.current.m.mutate({ conversationId: "c1", status: "RESOLVED" });
    });
    await waitFor(() => expect(detail(client).status).toBe("RESOLVED"));
    first.resolve(json(200, { conversation: conversation({ status: "PENDING" }) }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.count("GET", "/api/conversations/c1")).toBe(0); // not reconciled while another is pending
    second.resolve(json(200, { conversation: conversation({ status: "RESOLVED" }) }));
    await waitFor(() => expect(api.count("GET", "/api/conversations/c1")).toBe(1));
  });
});

describe("conversation priority (optimistic)", () => {
  it("raises the priority immediately", async () => {
    const client = seed();
    const gate = deferred<Response>();
    mockApi({ "PATCH /api/conversations/c1": () => gate.promise });
    const { result } = renderHookWithQuery(() => useChangeConversationPriority(), { client });
    act(() => result.current.mutate({ conversationId: "c1", priority: "HIGH" }));
    await waitFor(() => expect(detail(client).priority).toBe("HIGH"));
    expect(listed(client).priority).toBe("HIGH");
    gate.resolve(json(200, { conversation: conversation({ priority: "HIGH" }) }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores the old priority when the update fails", async () => {
    const client = seed({ priority: "NORMAL" });
    mockApi({
      "PATCH /api/conversations/c1": () => apiError(500, "internal_error", "Something went wrong"),
    });
    const { result } = renderHookWithQuery(() => useChangeConversationPriority(), { client });
    act(() => result.current.mutate({ conversationId: "c1", priority: "URGENT" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(detail(client).priority).toBe("NORMAL");
    expect(listed(client).priority).toBe("NORMAL");
  });
});

describe("conversation assignment (optimistic)", () => {
  it("shows the new assignee immediately", async () => {
    const client = seed();
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/conversations/c1/assign": () => gate.promise });
    const { result } = renderHookWithQuery(() => useAssignConversation(), { client });
    act(() => result.current.mutate({ conversationId: "c1", assignee: dana }));
    await waitFor(() => expect(detail(client).assignee).toEqual(dana));
    expect(listed(client).assignee).toEqual(dana);
    expect(api.calls[0].body).toEqual({ userId: "u1" });
    gate.resolve(json(200, { conversation: conversation({ assignee: dana }) }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("restores the previous assignee when assignment fails", async () => {
    const previous = { id: "u9", name: "Eli", email: "eli@example.com" };
    const client = seed({ assignee: previous });
    mockApi({
      "POST /api/conversations/c1/assign": () =>
        apiError(403, "forbidden", "You do not have permission to perform this action"),
    });
    const { result } = renderHookWithQuery(() => useAssignConversation(), { client });
    act(() => result.current.mutate({ conversationId: "c1", assignee: dana }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(detail(client).assignee).toEqual(previous);
    expect(listed(client).assignee).toEqual(previous);
  });

  it("unassigns immediately and restores the assignee on failure", async () => {
    const client = seed({ assignee: dana });
    const gate = deferred<Response>();
    mockApi({ "POST /api/conversations/c1/unassign": () => gate.promise });
    const { result } = renderHookWithQuery(() => useUnassignConversation(), { client });
    act(() => result.current.mutate({ conversationId: "c1" }));
    await waitFor(() => expect(detail(client).assignee).toBeNull());
    gate.resolve(apiError(500, "internal_error", "Something went wrong"));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(detail(client).assignee).toEqual(dana);
  });
});

describe("mark as read (optimistic)", () => {
  it("clears the unread flag immediately and does not refetch when the server agrees", async () => {
    const client = seed({ unread: true });
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/conversations/c1/read": () => gate.promise });
    const { result } = renderHookWithQuery(() => useMarkConversationRead(), { client });
    act(() => result.current.mutate({ conversationId: "c1" }));
    await waitFor(() => expect(detail(client).unread).toBe(false));
    expect(listed(client).unread).toBe(false);
    gate.resolve(noContent());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.calls.filter((c) => c.method === "GET")).toHaveLength(0);
  });

  it("restores the unread state when the request fails", async () => {
    const client = seed({ unread: true });
    mockApi({
      "POST /api/conversations/c1/read": () =>
        apiError(500, "internal_error", "Something went wrong"),
    });
    const { result } = renderHookWithQuery(() => useMarkConversationRead(), { client });
    act(() => result.current.mutate({ conversationId: "c1" }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(detail(client).unread).toBe(true);
    expect(listed(client).unread).toBe(true);
  });
});

describe("create conversation", () => {
  it("refreshes the inbox lists and the customer's 360 (not optimistic: it needs a server id)", async () => {
    const client = createTestQueryClient();
    const api = mockApi({
      "POST /api/conversations": () => json(201, { conversation: { id: "new" } }),
    });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useCreateConversation(), { client });
    act(() => result.current.mutate({ customerId: "cust1", subject: "Hi", priority: "NORMAL" }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.calls[0].body).toEqual({ customerId: "cust1", subject: "Hi", priority: "NORMAL" });
    expect(spy.mock.calls.map((c) => (c[0] as { queryKey: unknown }).queryKey)).toEqual([
      conversationsKeys.lists(TEST_ORG),
      ["org", TEST_ORG, "customers", "item", "cust1", "detail"],
    ]);
  });
});

describe("sending messages (outbox)", () => {
  const messagesKey = (includeInternal: boolean) =>
    conversationsKeys.messages(TEST_ORG, "c1", { limit: 50, includeInternal });
  const messages = (client: Client, includeInternal: boolean) =>
    client.getQueryData<MessagesResponse>(messagesKey(includeInternal))!.items.map((m) => m.id);
  const seedMessages = (client: Client) => {
    for (const includeInternal of [true, false]) {
      client.setQueryData<MessagesResponse>(messagesKey(includeInternal), {
        items: [message({ id: "m0" })],
        hasMore: false,
        nextCursor: null,
        total: 1,
      });
    }
  };

  it("shows the message as 'sending' immediately without touching the cache, then replaces it with the server's message", async () => {
    const client = createTestQueryClient();
    seedMessages(client);
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/conversations/c1/messages": () => gate.promise });
    const { result } = renderHookWithQuery(() => useMessageOutbox("c1"), { client });

    let sent!: Promise<boolean>;
    act(() => {
      sent = result.current.send({ body: "On it!", type: "MESSAGE", from: "USER" });
    });
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]).toMatchObject({ status: "sending", input: { body: "On it!" } });
    expect(result.current.items[0].clientId.startsWith("client-")).toBe(true);
    expect(messages(client, true)).toEqual(["m0"]); // no fake record in server state

    gate.resolve(json(201, { message: message({ id: "m-server", body: "On it!" }) }));
    expect(await sent).toBe(true);
    // Accepted by the server: the real message is in the cache and the item is reconciled by id.
    expect(messages(client, true)).toEqual(["m0", "m-server"]);
    await waitFor(() =>
      expect(result.current.items[0]).toMatchObject({ status: "sent", serverId: "m-server" }),
    );
    // Same item, same clientId, throughout: no second entry was created.
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0].clientId).toBe("client-1");
    expect(api.calls[0].body).toEqual({ body: "On it!", type: "MESSAGE", from: "USER" });
  });

  it("keeps a failed message visible as 'failed' with the safe error, and retry sends it again", async () => {
    const client = createTestQueryClient();
    seedMessages(client);
    let attempts = 0;
    mockApi({
      "POST /api/conversations/c1/messages": () =>
        ++attempts === 1
          ? apiError(409, "conflict", "This conversation is resolved. Reopen it before replying.")
          : json(201, { message: message({ id: "m-ok" }) }),
    });
    const { result } = renderHookWithQuery(() => useMessageOutbox("c1"), { client });

    await act(async () => {
      await result.current.send({ body: "Too late", type: "MESSAGE", from: "USER" });
    });
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({
      status: "failed",
      error: "This conversation is resolved. Reopen it before replying.",
    });
    expect(messages(client, true)).toEqual(["m0"]);

    await act(async () => {
      await result.current.retry(result.current.items[0].clientId);
    });
    expect(result.current.items[0]).toMatchObject({ status: "sent", serverId: "m-ok" });
    expect(messages(client, true)).toEqual(["m0", "m-ok"]);
    // A sent item can never be retried again, so a retry cannot post the message twice.
    await act(async () => {
      expect(await result.current.retry(result.current.items[0].clientId)).toBe(false);
    });
    expect(attempts).toBe(2);
  });

  it("lets the user discard a failed message", async () => {
    const client = createTestQueryClient();
    mockApi({
      "POST /api/conversations/c1/messages": () =>
        apiError(500, "internal_error", "Something went wrong"),
    });
    const { result } = renderHookWithQuery(() => useMessageOutbox("c1"), { client });
    await act(async () => {
      await result.current.send({ body: "x", type: "MESSAGE", from: "USER" });
    });
    act(() => result.current.discard(result.current.items[0].clientId));
    expect(result.current.items).toEqual([]);
  });

  it("adds an internal note only to the staff view, never to customer-facing history", async () => {
    const client = createTestQueryClient();
    seedMessages(client);
    mockApi({
      "POST /api/conversations/c1/messages": () =>
        json(201, { message: message({ id: "note1", messageType: "INTERNAL_NOTE" }) }),
    });
    const { result } = renderHookWithQuery(() => useMessageOutbox("c1"), { client });
    await act(async () => {
      await result.current.send({ body: "private", type: "INTERNAL_NOTE", from: "USER" });
    });
    expect(messages(client, true)).toEqual(["m0", "note1"]);
    expect(messages(client, false)).toEqual(["m0"]);
  });

  it("invalidates history, the conversation, lists and events once the message is accepted", async () => {
    const client = createTestQueryClient();
    mockApi({ "POST /api/conversations/c1/messages": () => json(201, { message: message() }) });
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(() => useMessageOutbox("c1"), { client });
    await act(async () => {
      await result.current.send({ body: "hi", type: "MESSAGE", from: "USER" });
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(4));
    const keys = spy.mock.calls.map((c) =>
      JSON.stringify((c[0] as { queryKey: unknown }).queryKey),
    );
    expect(keys).toContain(JSON.stringify(conversationsKeys.messagesAll(TEST_ORG, "c1")));
    expect(keys).toContain(JSON.stringify(conversationsKeys.detail(TEST_ORG, "c1")));
    expect(keys).toContain(JSON.stringify(conversationsKeys.lists(TEST_ORG)));
  });
});

describe("Ask AI (generates a draft; stores nothing)", () => {
  const draftBody = {
    draft: "Refunds take 30 days.",
    grounded: true,
    intent: "SUPPORT",
    sources: [{ documentId: "d1", documentTitle: "Refund policy", chunkId: "k1", chunkIndex: 0 }],
    approvals: [],
  };
  const key = conversationsKeys.messages(TEST_ORG, "c1", { limit: 50, includeInternal: true });
  const seed = (client: ReturnType<typeof createTestQueryClient>) =>
    client.setQueryData<MessagesResponse>(key, {
      items: [message({ id: "m0", senderType: "CUSTOMER", senderUserId: null, sender: null })],
      hasMore: false,
      nextCursor: null,
      total: 1,
    });

  it("is pending while the server works, then returns the draft without touching the message cache", async () => {
    const client = createTestQueryClient();
    seed(client);
    const gate = deferred<Response>();
    const api = mockApi({ "POST /api/conversations/c1/ai-draft": () => gate.promise });
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHookWithQuery(
      () => ({
        ai: useAiDraft("c1"),
        running: useIsMutating({ mutationKey: mutationKeys.aiDraft(TEST_ORG, "c1") }),
      }),
      { client },
    );

    act(() => result.current.ai.mutate());
    await waitFor(() => expect(result.current.ai.isPending).toBe(true));
    expect(result.current.running).toBe(1);

    gate.resolve(json(200, draftBody));
    await waitFor(() => expect(result.current.ai.isSuccess).toBe(true));
    expect(result.current.ai.data).toEqual(draftBody);
    expect(result.current.running).toBe(0);
    expect(client.getQueryData<MessagesResponse>(key)!.items.map((m) => m.id)).toEqual(["m0"]);
    expect(invalidate).not.toHaveBeenCalled(); // the server stored nothing, so nothing to refetch
    expect(api.count("POST", "/api/conversations/c1/ai-draft")).toBe(1);
  });

  it("surfaces the safe error, adds nothing, and does not retry the generation automatically", async () => {
    const client = createTestQueryClient();
    seed(client);
    const api = mockApi({
      "POST /api/conversations/c1/ai-draft": () =>
        apiError(
          502,
          "ai_unavailable",
          "The AI service is temporarily unavailable. Please try again.",
        ),
    });
    const { result } = renderHookWithQuery(() => useAiDraft("c1"), { client });
    act(() => result.current.mutate());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe(
      "The AI service is temporarily unavailable. Please try again.",
    );
    expect(result.current.isPending).toBe(false);
    expect(client.getQueryData<MessagesResponse>(key)!.items.map((m) => m.id)).toEqual(["m0"]);
    expect(api.count("POST", "/api/conversations/c1/ai-draft")).toBe(1);
  });
});
