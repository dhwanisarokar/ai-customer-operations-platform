// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
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

  it("shows a sent reply as 'Sending…' immediately, then confirms it", async () => {
    const gate = deferred<Response>();
    mockApi({ ...baseRoutes(), "POST /api/conversations/c1/messages": () => gate.promise });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "On it");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByText("On it")).toBeInTheDocument();
    expect(screen.getByText(/Sending/)).toBeInTheDocument();
    gate.resolve(json(201, { message: message({ body: "On it" }) }));
    await waitFor(() => expect(screen.queryByText(/Sending/)).not.toBeInTheDocument());
  });

  it("keeps a failed reply visible with a retry action", async () => {
    mockApi({
      ...baseRoutes(),
      "POST /api/conversations/c1/messages": () => apiError(500, "internal_error", "Boom"),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "Will fail");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByRole("button", { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText("Will fail")).toBeInTheDocument();
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
});
