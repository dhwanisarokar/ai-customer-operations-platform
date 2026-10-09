// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, json, mockApi } from "../../../../tests/helpers/query";
import { WidgetSessionProvider } from "../hooks/use-widget-session";
import { ChatWidget } from "./chat-widget";

const KEY = "wk_testkeytestkeytest";
const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: "c1",
  subject: "can it be done eariler?",
  status: "OPEN",
  lastMessageAt: "2026-01-01T10:00:00.000Z",
  lastMessagePreview: "I couldn't find that.",
  humanRequested: false,
  assistant: "ai",
  lastMessageFrom: "ai",
  createdAt: "2026-01-01T10:00:00.000Z",
  ...overrides,
});
const msg = (
  id: string,
  from: "visitor" | "ai" | "team",
  body: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  from,
  body,
  createdAt: new Date().toISOString(),
  clientMessageId: null,
  authorName: from === "team" ? "Sarah" : null,
  handoffSuggested: false,
  ...extra,
});
const FALLBACK =
  "I couldn't find that in our policy. If you'd like, I can connect you with our support team.";
const fallbackMessages = [
  msg("m1", "visitor", "can it be done eariler?"),
  msg("m2", "ai", FALLBACK, { handoffSuggested: true }),
];

const sessionOk = () =>
  json(200, {
    token: "vs_t",
    session: { id: "s1", expiresAt: "2026-02-01T00:00:00.000Z" },
    widget: { displayName: "Acme", welcomeMessage: "Welcome", accentColor: null },
  });
const quietStream = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode("event: ready\ndata: {}\n\n"));
      },
    }),
    { status: 200 },
  );

function renderWidget() {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <WidgetSessionProvider widgetKey={KEY}>
        <ChatWidget />
      </WidgetSessionProvider>
    </QueryClientProvider>,
  );
}
const actions = () => screen.queryAllByRole("button", { name: "Talk to a person" });
const status = () => screen.queryAllByText("A support agent has been requested.");

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("exactly one human-handoff action", () => {
  it("an AI fallback that offers a person renders ONE action (not one per place)", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, { conversation: conversation(), messages: fallbackMessages }),
      "GET /api/widget/conversations": () => json(200, { conversations: [conversation()] }),
      "GET /api/widget/events": quietStream,
    });
    renderWidget();
    expect(await screen.findByText(FALLBACK)).toBeTruthy();
    expect(actions()).toHaveLength(1);
    expect(status()).toHaveLength(0);
    // The AI text itself is not an action: it is plain text.
    expect(screen.getByText(FALLBACK).closest("button")).toBeNull();
  });

  it("requesting replaces the action with a non-interactive status and sends one request", async () => {
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
          conversation: conversation({
            humanRequested: requested,
            assistant: requested ? "human" : "ai",
          }),
          messages: fallbackMessages,
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [conversation()] }),
      "GET /api/widget/events": quietStream,
    });
    renderWidget();
    await user.click(await screen.findByRole("button", { name: "Talk to a person" }));
    await waitFor(() => expect(status()).toHaveLength(1));
    expect(actions()).toHaveLength(0);
    expect(api.calls.filter((c) => c.url.endsWith("/handoff"))).toHaveLength(1);
    // The status is not a control.
    expect(status()[0].closest("button")).toBeNull();
  });

  it("an already requested conversation (reload) shows the status once and no action", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: conversation({ humanRequested: true, assistant: "human" }),
          messages: fallbackMessages,
        }),
      "GET /api/widget/conversations": () =>
        json(200, { conversations: [conversation({ humanRequested: true, assistant: "human" })] }),
      "GET /api/widget/events": quietStream,
    });
    renderWidget();
    await waitFor(() => expect(status()).toHaveLength(1));
    expect(actions()).toHaveLength(0);
  });

  it("a realtime update that turns the chat into a handoff leaves exactly one status and no action", async () => {
    let requested = false;
    const hint = JSON.stringify({ type: "conversation.updated", conversationId: "c1" });
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: conversation({
            humanRequested: requested,
            assistant: requested ? "human" : "ai",
          }),
          messages: fallbackMessages,
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [conversation()] }),
      "GET /api/widget/events": () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const enc = new TextEncoder();
              controller.enqueue(enc.encode("event: ready\ndata: {}\n\n"));
              setTimeout(() => {
                requested = true; // the visitor asked on another tab / the AI path
                controller.enqueue(enc.encode(`event: conversation.updated\ndata: ${hint}\n\n`));
              }, 300);
            },
          }),
          { status: 200 },
        ),
    });
    renderWidget();
    expect(await screen.findByRole("button", { name: "Talk to a person" })).toBeTruthy();
    await waitFor(() => expect(status()).toHaveLength(1), { timeout: 4000 });
    expect(actions()).toHaveLength(0);
  });

  it("once a person took over (human handling, no pending request) no stale action shows", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: conversation({ assistant: "human", lastMessageFrom: "team" }),
          messages: [...fallbackMessages, msg("m3", "team", "Hi, I'm Sarah.")],
        }),
      "GET /api/widget/conversations": () =>
        json(200, { conversations: [conversation({ assistant: "human" })] }),
      "GET /api/widget/events": quietStream,
    });
    renderWidget();
    expect(await screen.findByText("Hi, I'm Sarah.")).toBeTruthy();
    expect(actions()).toHaveLength(0);
    expect(status()).toHaveLength(0);
  });

  it("sharing an email keeps working independently of the handoff control", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "POST /api/widget/session": sessionOk,
      "POST /api/widget/identity": () => json(200, { ok: true }),
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: conversation({ humanRequested: true, assistant: "human" }),
          messages: fallbackMessages,
        }),
      "GET /api/widget/conversations": () =>
        json(200, { conversations: [conversation({ humanRequested: true, assistant: "human" })] }),
      "GET /api/widget/events": quietStream,
    });
    renderWidget();
    await user.click(await screen.findByRole("button", { name: "Share your email" }));
    await user.type(screen.getByLabelText("Your email"), "alice@example.com");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(api.calls.find((c) => c.url === "/api/widget/identity")?.body).toEqual({
        email: "alice@example.com",
      }),
    );
    // The form closes; the handoff status is untouched.
    await waitFor(() => expect(screen.queryByLabelText("Your email")).toBeNull());
    expect(status()).toHaveLength(1);
  });
});
