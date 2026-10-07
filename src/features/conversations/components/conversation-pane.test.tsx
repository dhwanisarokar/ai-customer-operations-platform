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
  approvals: { approvals: [] },
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

  describe("AI suggestion in the single compose box", () => {
    const groundedDraft = {
      draft: "Refunds take 30 days.",
      grounded: true,
      intent: "SUPPORT",
      sources: [{ documentId: "d1", documentTitle: "Refund policy", chunkId: "k1", chunkIndex: 0 }],
      approvals: [],
    };
    const ungroundedDraft = {
      draft: "Not sure.",
      grounded: false,
      intent: "SUPPORT",
      sources: [],
      approvals: [],
    };
    const draftRoute = (body: unknown) => ({
      ...baseRoutes(),
      "POST /api/conversations/c1/ai-draft": () => json(200, body),
    });

    it("Ask AI pre-fills the ONE compose box (no second text box) and adds no message", async () => {
      const api = mockApi(draftRoute(groundedDraft));
      const user = userEvent.setup();
      renderPane();
      await user.click(screen.getByRole("button", { name: "Ask AI" }));

      const box = await screen.findByDisplayValue("Refunds take 30 days.");
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(box).toHaveAttribute("id", "composer-body");
      const banner = screen.getByRole("status", { name: "AI suggested reply" });
      expect(banner).toHaveTextContent("Based on: Refund policy");
      expect(screen.getAllByRole("button", { name: "Send reply" })).toHaveLength(1);
      expect(screen.queryByRole("article", { name: "AI message" })).not.toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Agent message" })).not.toBeInTheDocument();
      expect(api.count("POST", "/api/conversations/c1/messages")).toBe(0);
    });

    it("an ungrounded suggestion shows the warning, still only as an unsent draft", async () => {
      mockApi(draftRoute(ungroundedDraft));
      const user = userEvent.setup();
      renderPane();
      await user.click(screen.getByRole("button", { name: "Ask AI" }));
      const banner = await screen.findByRole("status", { name: "AI suggested reply" });
      expect(banner).toHaveTextContent("Not based on your knowledge base");
      expect(banner).not.toHaveTextContent("Review before sending");
    });

    it("editing changes only the box; Discard empties it and removes the banner, nothing is created", async () => {
      const api = mockApi(draftRoute(groundedDraft));
      const user = userEvent.setup();
      renderPane();
      await user.click(screen.getByRole("button", { name: "Ask AI" }));
      const box = await screen.findByDisplayValue("Refunds take 30 days.");
      await user.clear(box);
      await user.type(box, "Edited text");
      expect(screen.getByRole("textbox")).toHaveValue("Edited text");
      expect(api.count("POST", "/api/conversations/c1/messages")).toBe(0);

      await user.click(screen.getByRole("button", { name: "Discard" }));
      expect(screen.queryByRole("status", { name: "AI suggested reply" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("");
      expect(api.count("POST", "/api/conversations/c1/messages")).toBe(0);
    });

    it("asking again replaces the suggestion (still one box, one banner)", async () => {
      let n = 0;
      mockApi({
        ...baseRoutes(),
        "POST /api/conversations/c1/ai-draft": () =>
          json(200, { ...ungroundedDraft, draft: ++n === 1 ? "Draft A" : "Draft B" }),
      });
      const user = userEvent.setup();
      renderPane();
      await user.click(screen.getByRole("button", { name: "Ask AI" }));
      await screen.findByDisplayValue("Draft A");
      await user.click(screen.getByRole("button", { name: "Ask AI" }));
      await screen.findByDisplayValue("Draft B");
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(screen.getAllByRole("status", { name: "AI suggested reply" })).toHaveLength(1);
    });

    it("sending uses the normal message flow: optimistic bubble, then exactly one sent message", async () => {
      const gate = deferred<Response>();
      const posted: ReturnType<typeof message>[] = [];
      const api = mockApi({
        ...baseRoutes(),
        ...withPersisted(posted),
        "POST /api/conversations/c1/ai-draft": () => json(200, groundedDraft),
        "POST /api/conversations/c1/messages": () => gate.promise,
      });
      const user = userEvent.setup();
      renderPane();
      await user.click(screen.getByRole("button", { name: "Ask AI" }));
      const box = await screen.findByDisplayValue("Refunds take 30 days.");
      await user.clear(box);
      await user.type(box, "Edited and approved");
      await user.click(screen.getByRole("button", { name: "Send reply" }));

      // The banner is gone, the box is empty again, and the text is an ordinary agent bubble.
      expect(screen.queryByRole("status", { name: "AI suggested reply" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("");
      const bubble = await screen.findByRole("article", { name: "Agent message" });
      expect(bubble).toHaveTextContent("Edited and approved");
      expect(within(bubble).getByRole("img", { name: "Sending" })).toBeInTheDocument();
      expect(
        api.calls.find((c) => c.url.endsWith("/messages") && c.method === "POST")!.body,
      ).toEqual({ body: "Edited and approved", type: "MESSAGE", from: "USER" });

      const saved = message({ id: "m-ai", body: "Edited and approved", senderType: "USER" });
      posted.push(saved);
      gate.resolve(json(201, { message: saved }));
      await waitFor(() => expect(screen.getByRole("img", { name: "Sent" })).toBeInTheDocument());
      expect(screen.getAllByText("Edited and approved")).toHaveLength(1);
      expect(screen.queryByRole("article", { name: "AI message" })).not.toBeInTheDocument();
    });

    it("a failed AI request leaves the box untouched and creates no message", async () => {
      mockApi({
        ...baseRoutes(),
        "POST /api/conversations/c1/ai-draft": () =>
          apiError(502, "ai_unavailable", "The AI service is temporarily unavailable."),
      });
      const user = userEvent.setup();
      renderPane();
      await user.type(screen.getByRole("textbox"), "my own text");
      await user.click(screen.getByRole("button", { name: "Ask AI" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
      expect(screen.queryByRole("status", { name: "AI suggested reply" })).not.toBeInTheDocument();
      expect(screen.getByRole("textbox")).toHaveValue("my own text");
      expect(screen.getByRole("button", { name: "Ask AI" })).toBeEnabled();
    });

    it("when the AI requests a change, an approval card appears and the draft flow still works", async () => {
      const pendingApproval = {
        id: "a1",
        conversationId: "c1",
        toolName: "changeConversationStatus",
        riskLevel: "MEDIUM",
        status: "PENDING",
        preview: {
          title: "Change conversation status",
          lines: [{ label: "Status", from: "Open", to: "Resolved" }],
        },
        requestedByUserId: "u1",
        createdAt: "2026-01-01T10:00:00.000Z",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        failureCode: null,
      };
      mockApi({
        // More specific routes first: matching is by prefix.
        "GET /api/conversations/c1/ai-approvals": () => json(200, { approvals: [pendingApproval] }),
        ...baseRoutes(),
        "POST /api/conversations/c1/ai-draft": () =>
          json(200, {
            ...ungroundedDraft,
            draft: "A team member will review.",
            approvals: [pendingApproval],
          }),
      });
      const user = userEvent.setup();
      renderPane();
      expect(screen.queryByRole("region", { name: "AI action requires approval" })).toBeNull();
      await user.click(screen.getByRole("button", { name: "Ask AI" }));

      const card = await screen.findByRole("region", { name: "AI action requires approval" });
      expect(card).toHaveTextContent("Change conversation status");
      // The suggested reply is still just a draft in the single compose box.
      expect(await screen.findByDisplayValue("A team member will review.")).toBeInTheDocument();
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
    });
  });
});
