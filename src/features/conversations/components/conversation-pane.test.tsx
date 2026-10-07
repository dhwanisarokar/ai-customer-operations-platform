// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, message } from "../../../../tests/helpers/fixtures";
import {
  apiError,
  deferred,
  json,
  mockApi,
  renderWithQuery,
} from "../../../../tests/helpers/query";
import { ConversationPane } from "./conversation-pane";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const initial = {
  conversation: { conversation: conversation() },
  messages: {
    items: [message({ body: "Hi from customer", senderType: "CUSTOMER" })],
    hasMore: false,
  },
  events: { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 },
  members: { members: [] },
} as unknown as React.ComponentProps<typeof ConversationPane>["initial"];

function renderPane() {
  return renderWithQuery(
    <ConversationPane
      conversationId="c1"
      initial={initial}
      currentUserId="me"
      can={{ update: true, assign: false, send: true }}
      closeHref="/inbox"
    />,
  );
}

/** A server whose message list includes whatever has been posted so far (like the real API). */
function withPersisted(posted: ReturnType<typeof message>[]) {
  return {
    "GET /api/conversations/c1/messages": () =>
      json(200, { ...initial.messages, items: [...initial.messages.items, ...posted] }),
  };
}

const baseRoutes = () => ({
  "GET /api/conversations/c1/messages": () => json(200, initial.messages),
  "GET /api/conversations/c1/events": () => json(200, initial.events),
  "GET /api/conversations/c1": () => json(200, initial.conversation),
  "GET /api/conversations?": () =>
    json(200, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 }),
  "POST /api/conversations/c1/read": () => json(200, initial.conversation),
});

describe("ConversationPane", () => {
  it("marks the conversation read once on open and does not loop", async () => {
    const api = mockApi(baseRoutes());
    renderPane();
    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/read")).toBe(1));
    await new Promise((r) => setTimeout(r, 100));
    expect(api.count("POST", "/api/conversations/c1/read")).toBe(1);
  });

  it("shows a sent message at once as a normal message with a sending indicator, then 'sent'", async () => {
    const gate = deferred<Response>();
    const posted: ReturnType<typeof message>[] = [];
    mockApi({
      ...baseRoutes(),
      ...withPersisted(posted),
      "POST /api/conversations/c1/messages": () => gate.promise,
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "On it");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    // Immediately a regular agent bubble with a small indicator; no "Sending..." text anywhere.
    const bubble = await screen.findByRole("article", { name: "Agent message" });
    expect(bubble).toHaveTextContent("On it");
    expect(within(bubble).getByRole("img", { name: "Sending" })).toBeInTheDocument();
    expect(screen.queryByText(/Sending\.\.\./)).not.toBeInTheDocument();

    const saved = message({ id: "m-srv", body: "On it", senderType: "USER" });
    posted.push(saved);
    gate.resolve(json(201, { message: saved }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Sent" })).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: "Sending" })).not.toBeInTheDocument();
    expect(screen.getAllByText("On it")).toHaveLength(1);
  });

  it("keeps a failed message in place with a failed indicator, Retry and Discard", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/conversations/c1/messages": () => apiError(500, "internal_error", "Boom"),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "Will fail");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByRole("img", { name: "Failed to send" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getAllByText("Will fail")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /discard/i }));
    expect(screen.queryByText("Will fail")).not.toBeInTheDocument();
  });

  it("shows an AI pending row while the reply is generated, never optimistically", async () => {
    const gate = deferred<Response>();
    mockApi({ ...baseRoutes(), "POST /api/conversations/c1/ai-reply": () => gate.promise });
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    expect(await screen.findByText(/AI Agent is writing a reply/i)).toBeInTheDocument();
    gate.resolve(json(201, { message: message({ senderType: "AI_AGENT", body: "Answer" }) }));
    await waitFor(() =>
      expect(screen.queryByText(/AI Agent is writing a reply/i)).not.toBeInTheDocument(),
    );
  });

  it("shows the sent message exactly once while the refetch is still in flight, and after it", async () => {
    const refetch = deferred<Response>();
    let gets = 0;
    mockApi({
      ...baseRoutes(),
      "POST /api/conversations/c1/messages": () =>
        json(201, { message: message({ id: "m-new", body: "Exactly once", senderType: "USER" }) }),
      "GET /api/conversations/c1/messages": () =>
        ++gets === 1 ? refetch.promise : json(200, initial.messages),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "Exactly once");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(screen.getByRole("img", { name: "Sent" })).toBeInTheDocument());
    expect(screen.getAllByText("Exactly once")).toHaveLength(1);

    // The server refetch (which contains the same persisted message) must not add a second copy.
    refetch.resolve(
      json(200, {
        ...initial.messages,
        items: [
          ...initial.messages.items,
          message({ id: "m-new", body: "Exactly once", senderType: "USER" }),
        ],
      }),
    );
    await waitFor(() => expect(gets).toBeGreaterThan(0));
    await waitFor(() => expect(screen.getAllByText("Exactly once")).toHaveLength(1));
    expect(screen.getAllByRole("img", { name: "Sent" })).toHaveLength(1);
  });

  it("retry re-sends the same message once: failed -> sending -> sent, never two copies", async () => {
    const gate = deferred<Response>();
    let posts = 0;
    const posted: ReturnType<typeof message>[] = [];
    const api = mockApi({
      ...baseRoutes(),
      ...withPersisted(posted),
      "POST /api/conversations/c1/messages": () =>
        ++posts === 1 ? apiError(500, "internal_error", "Boom") : gate.promise,
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "Try again");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    await user.click(await screen.findByRole("button", { name: /retry/i }));

    // While retrying: same single bubble, back to the sending indicator.
    expect(await screen.findByRole("img", { name: "Sending" })).toBeInTheDocument();
    expect(screen.getAllByText("Try again")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /retry/i })).not.toBeInTheDocument();

    const saved = message({ id: "m-ok", body: "Try again", senderType: "USER" });
    posted.push(saved);
    gate.resolve(json(201, { message: saved }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Sent" })).toBeInTheDocument());
    expect(screen.getAllByText("Try again")).toHaveLength(1);
    expect(api.count("POST", "/api/conversations/c1/messages")).toBe(2);
  });

  it("drops the AI pending row the moment the real AI message is rendered (no duplicate)", async () => {
    const refetch = deferred<Response>();
    let gets = 0;
    mockApi({
      ...baseRoutes(),
      "POST /api/conversations/c1/ai-reply": () =>
        json(201, { message: message({ id: "ai1", senderType: "AI_AGENT", body: "Real answer" }) }),
      "GET /api/conversations/c1/messages": () =>
        ++gets === 1 ? refetch.promise : json(200, initial.messages),
    });
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole("button", { name: "Ask AI" }));

    // The refetch is still running, yet the pending row is gone and the real reply shows once.
    expect(await screen.findByText("Real answer")).toBeInTheDocument();
    expect(screen.queryByText(/AI Agent is writing a reply/i)).not.toBeInTheDocument();
    expect(screen.getAllByText("Real answer")).toHaveLength(1);
    refetch.resolve(json(200, initial.messages));
  });

  it("clears the AI pending row when generation fails", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/conversations/c1/ai-reply": () =>
        apiError(502, "ai_unavailable", "The AI service is temporarily unavailable."),
    });
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole("button", { name: "Ask AI" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    expect(screen.queryByText(/AI Agent is writing a reply/i)).not.toBeInTheDocument();
  });
});
