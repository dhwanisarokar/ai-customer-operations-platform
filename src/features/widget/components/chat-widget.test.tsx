// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import {
  apiError,
  createTestQueryClient,
  deferred,
  json,
  mockApi,
} from "../../../../tests/helpers/query";
import { WidgetSessionProvider } from "../hooks/use-widget-session";
import { parseSseBuffer, backoffDelay } from "../hooks/use-widget-realtime";
import { ChatWidget } from "./chat-widget";

const KEY = "wk_testkeytestkeytest";
const CONVERSATION = {
  id: "c1",
  subject: "Hello",
  status: "OPEN",
  lastMessageAt: "2026-01-01T10:00:00.000Z",
  lastMessagePreview: "Hello",
  humanRequested: false,
  assistant: "none",
  lastMessageFrom: "visitor",
  createdAt: "2026-01-01T10:00:00.000Z",
};
const message = (
  id: string,
  from: "visitor" | "team" | "ai",
  body: string,
  clientMessageId: string | null = null,
) => ({
  id,
  from,
  body,
  createdAt: "2026-01-01T10:00:00.000Z",
  clientMessageId,
  authorName: from === "team" ? "Dana" : null,
  handoffSuggested: false,
});

const sessionOk = () =>
  json(200, {
    token: "vs_testtoken",
    session: { id: "s1", expiresAt: "2026-02-01T00:00:00.000Z" },
    widget: {
      displayName: "Acme Support",
      welcomeMessage: "Hi! How can we help?",
      accentColor: null,
    },
  });

/** An event stream that says "ready" and then stays open, like the real endpoint. */
const liveStream = () =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("retry: 3000\n\nevent: ready\ndata: {}\n\n"));
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );

function renderWidget() {
  const client = createTestQueryClient();
  render(
    <QueryClientProvider client={client}>
      <WidgetSessionProvider widgetKey={KEY} embedOrigin="https://shop.example.com">
        <ChatWidget />
      </WidgetSessionProvider>
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ChatWidget", () => {
  it("opens a session from the public key only and shows the welcome message", async () => {
    const api = mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations": () => json(200, { conversations: [] }),
      "GET /api/widget/events": liveStream,
    });
    renderWidget();
    expect(await screen.findByText("Hi! How can we help?")).toBeTruthy();
    expect(screen.getByText("Acme Support")).toBeTruthy();
    const call = api.calls.find((c) => c.url === "/api/widget/session");
    expect(call?.body).toEqual({ key: KEY, embedOrigin: "https://shop.example.com" });
    expect(window.localStorage.getItem(`cw:${KEY}`)).toBe("vs_testtoken");
  });

  it("opens exactly one visitor session even when effects run twice (StrictMode)", async () => {
    const api = mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations": () => json(200, { conversations: [] }),
      "GET /api/widget/events": liveStream,
    });
    const client = createTestQueryClient();
    render(
      <StrictMode>
        <QueryClientProvider client={client}>
          <WidgetSessionProvider widgetKey={KEY}>
            <ChatWidget />
          </WidgetSessionProvider>
        </QueryClientProvider>
      </StrictMode>,
    );
    await screen.findByText("Hi! How can we help?");
    expect(api.calls.filter((c) => c.url === "/api/widget/session")).toHaveLength(1);
  });

  it("shows an unavailable state when the widget is disabled", async () => {
    mockApi({
      "POST /api/widget/session": () => apiError(404, "not_found", "Chat is not available"),
    });
    renderWidget();
    expect(await screen.findByText(/not available right now/i)).toBeTruthy();
  });

  it("starts a chat with a client message id and opens the conversation", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "POST /api/widget/session": sessionOk,
      "POST /api/widget/conversations": () =>
        json(201, { conversation: CONVERSATION, messages: [message("m1", "visitor", "Hello")] }),
      "GET /api/widget/conversations/c1": () =>
        json(200, { conversation: CONVERSATION, messages: [message("m1", "visitor", "Hello")] }),
      "GET /api/widget/conversations": () => json(200, { conversations: [] }),
      "GET /api/widget/events": liveStream,
    });
    renderWidget();
    await user.type(await screen.findByLabelText("Your message"), "Hello");
    await user.click(screen.getByRole("button", { name: "Start chat" }));
    expect(await screen.findByRole("log")).toBeTruthy();
    const create = api.calls.find(
      (c) => c.method === "POST" && c.url === "/api/widget/conversations",
    );
    expect(create?.body).toMatchObject({ body: "Hello" });
    expect((create?.body as { clientMessageId: string }).clientMessageId).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(Object.keys(create?.body as object).sort()).toEqual(["body", "clientMessageId"]);
  });

  it("shows sending, then keeps a failed message with retry that reuses the same id", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const gate = deferred<void>();
    const api = mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, { conversation: CONVERSATION, messages: [message("m1", "visitor", "Hello")] }),
      "POST /api/widget/conversations/c1/messages": async () => {
        attempts += 1;
        if (attempts === 1) {
          await gate.promise;
          return apiError(500, "internal_error", "Something went wrong");
        }
        return json(201, { message: message("m2", "visitor", "More", "x" as never) });
      },
      "GET /api/widget/conversations": () => json(200, { conversations: [CONVERSATION] }),
      "GET /api/widget/events": liveStream,
    });
    renderWidget();
    await user.type(await screen.findByLabelText("Your message"), "More");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Sending…")).toBeTruthy();
    gate.resolve();
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(attempts).toBe(2));
    const sends = api.calls.filter((c) => c.url.endsWith("/messages"));
    expect((sends[0].body as { clientMessageId: string }).clientMessageId).toBe(
      (sends[1].body as { clientMessageId: string }).clientMessageId,
    );
  });

  it("requests a human and shows the handoff state", async () => {
    const user = userEvent.setup();
    let requested = false;
    const api = mockApi({
      "POST /api/widget/session": sessionOk,
      "POST /api/widget/conversations/c1/handoff": () => {
        requested = true;
        return json(200, { humanRequested: true });
      },
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: { ...CONVERSATION, humanRequested: requested },
          messages: [message("m1", "visitor", "Hello")],
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [CONVERSATION] }),
      "GET /api/widget/events": liveStream,
    });
    renderWidget();
    await user.click(await screen.findByRole("button", { name: "Talk to a person" }));
    expect(await screen.findByText(/support agent has been requested/i)).toBeTruthy();
    expect(api.calls.some((c) => c.url.endsWith("/handoff"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Talk to a person" })).toBeNull();
  });

  it("shows team replies and a reconnecting notice when realtime is down", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: CONVERSATION,
          messages: [message("m1", "visitor", "Hello"), message("m2", "team", "We are on it")],
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [CONVERSATION] }),
      "GET /api/widget/events": () => apiError(503, "unavailable", "down"),
    });
    renderWidget();
    expect(await screen.findByText("Reconnecting…")).toBeTruthy();
    expect(await screen.findByText("We are on it")).toBeTruthy();
    expect(screen.getByText("Dana · Support team")).toBeTruthy();
  });

  it("starts a fresh session once when the server says the old one expired", async () => {
    window.localStorage.setItem(`cw:${KEY}`, "vs_old");
    let sessions = 0;
    let listCalls = 0;
    const api = mockApi({
      "POST /api/widget/session": () => {
        sessions += 1;
        return sessionOk();
      },
      "GET /api/widget/conversations": () => {
        listCalls += 1;
        return listCalls === 1
          ? apiError(401, "unauthorized", "Your chat session has expired")
          : json(200, { conversations: [] });
      },
      "GET /api/widget/events": liveStream,
    });
    renderWidget();
    expect(await screen.findByText("Hi! How can we help?")).toBeTruthy();
    await waitFor(() => expect(listCalls).toBe(2));
    expect(sessions).toBe(2);
    expect(window.localStorage.getItem(`cw:${KEY}`)).toBe("vs_testtoken");
    expect(api.calls.filter((c) => c.url === "/api/widget/session")).toHaveLength(2);
  });
});

describe("realtime helpers", () => {
  it("parses complete SSE messages and keeps the unfinished rest", () => {
    const parsed = parseSseBuffer(
      'retry: 3000\n\nevent: ready\ndata: {}\n\n: ping\n\nid: 1\nevent: message.created\ndata: {"type":"message.created"}\n\nevent: part',
    );
    expect(parsed.messages.map((m) => m.event)).toEqual(["ready", "message.created"]);
    expect(parsed.rest).toBe("event: part");
  });

  it("backs off up to a cap", () => {
    expect(backoffDelay(0)).toBe(1000);
    expect(backoffDelay(2)).toBe(4000);
    expect(backoffDelay(10)).toBe(15000);
  });
});
