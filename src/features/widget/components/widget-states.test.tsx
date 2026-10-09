// @vitest-environment jsdom
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, json, mockApi } from "../../../../tests/helpers/query";
import { WidgetSessionProvider } from "../hooks/use-widget-session";
import { initialView } from "../types";
import { ChatWidget } from "./chat-widget";

const KEY = "wk_testkeytestkeytest";
const base = {
  status: "OPEN",
  lastMessageAt: "2026-01-01T10:00:00.000Z",
  humanRequested: false,
  assistant: "ai",
  createdAt: "2026-01-01T10:00:00.000Z",
};
const refund = {
  ...base,
  id: "c1",
  subject: "can you tell me about refund policy?",
  lastMessagePreview: "can you tell me about refund policy?",
  lastMessageFrom: "visitor",
};
const resolved = {
  ...base,
  id: "c2",
  status: "RESOLVED",
  subject: "Shipping times?",
  lastMessagePreview: "Thanks!",
  lastMessageFrom: "visitor",
};
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

const sessionOk = () =>
  json(200, {
    token: "vs_t",
    session: { id: "s1", expiresAt: "2026-02-01T00:00:00.000Z" },
    widget: { displayName: "Acme", welcomeMessage: "Welcome! Ask us anything.", accentColor: null },
  });
const stream = () =>
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

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("initialView", () => {
  it("picks the screen from the existing conversations", () => {
    expect(initialView([])).toEqual({ name: "NEW_CONVERSATION" });
    expect(initialView([refund, resolved] as never).name).toBe("ACTIVE_CONVERSATION");
    expect(initialView([resolved] as never)).toEqual({ name: "WELCOME" });
  });
});

describe("widget screens", () => {
  it("NEW_CONVERSATION with no chats: welcome + Start chat", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations": () => json(200, { conversations: [] }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText("Welcome! Ask us anything.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("ACTIVE_CONVERSATION: an existing chat opens with Send and never Start chat", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: refund,
          messages: [
            msg("m1", "visitor", "can you tell me about refund policy?"),
            msg("m2", "ai", "Refunds within 30 days."),
          ],
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [refund, resolved] }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText("Refunds within 30 days.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
    expect(screen.getByText("AI assistant")).toBeTruthy();
  });

  it("WELCOME: titles differ from previews and New conversation leads to Start chat", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations": () =>
        json(200, {
          conversations: [
            { ...resolved, id: "c3", subject: refund.subject, lastMessagePreview: refund.subject },
          ],
        }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText("Refund policy")).toBeTruthy();
    // The title is the topic; the same sentence is not repeated as the preview.
    expect(screen.queryByText("can you tell me about refund policy?")).toBeNull();
    expect(screen.queryByRole("button", { name: "Start chat" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New conversation" }));
    expect(await screen.findByRole("button", { name: "Start chat" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Back to your chats" }));
    expect(await screen.findByRole("button", { name: "New conversation" })).toBeTruthy();
  });

  it("shows AI is thinking while the assistant has not answered yet", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, { conversation: refund, messages: [msg("m1", "visitor", "Refund?")] }),
      "GET /api/widget/conversations": () => json(200, { conversations: [refund] }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText("AI is thinking…")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Talk to a person" })).toBeTruthy();
  });

  it("does not show thinking when no assistant answers (AI off)", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: { ...refund, assistant: "none" },
          messages: [msg("m1", "visitor", "Refund?")],
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [refund] }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText("Refund?")).toBeTruthy();
    expect(screen.queryByText("AI is thinking…")).toBeNull();
  });

  it("an AI answer that suggests a person offers the handoff", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: { ...refund, lastMessageFrom: "ai" },
          messages: [
            msg("m1", "visitor", "Cancel my order"),
            msg(
              "m2",
              "ai",
              "I'm having trouble finding that information. Would you like to talk to a person?",
              {
                handoffSuggested: true,
              },
            ),
          ],
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [refund] }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText(/Would you like to talk to a person/)).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Talk to a person" }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("AI is thinking…")).toBeNull();
  });

  it("a person's message shows their name, labelled as the support team, and stops the AI", async () => {
    mockApi({
      "POST /api/widget/session": sessionOk,
      "GET /api/widget/conversations/c1": () =>
        json(200, {
          conversation: { ...refund, humanRequested: true, assistant: "human" },
          messages: [msg("m1", "visitor", "Hi"), msg("m2", "team", "Hi, I'm Sarah from support.")],
        }),
      "GET /api/widget/conversations": () => json(200, { conversations: [refund] }),
      "GET /api/widget/events": stream,
    });
    renderWidget();
    expect(await screen.findByText("Hi, I'm Sarah from support.")).toBeTruthy();
    expect(screen.getByText("Sarah · Support team")).toBeTruthy();
    expect(screen.queryByText("AI is thinking…")).toBeNull();
    expect(screen.getByText(/support agent has been requested/i)).toBeTruthy();
  });
});
