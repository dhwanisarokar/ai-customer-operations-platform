// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation, message } from "../../../../tests/helpers/fixtures";
import {
  apiError,
  json,
  mockApi,
  renderHookWithQuery,
  renderWithQuery,
} from "../../../../tests/helpers/query";
import type { EmailDeliveryJson, MessageJson } from "../api/types";
import { useConversationMessages, DELIVERY_REFRESH_MS } from "../hooks/queries";
import { ConversationPane } from "./conversation-pane";
import { ConversationTimeline } from "./conversation-timeline";
import { MessageComposer } from "./message-composer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const delivery = (over: Partial<EmailDeliveryJson> = {}): EmailDeliveryJson => ({
  state: "queued",
  retryAt: null,
  acceptedAt: null,
  failedAt: null,
  failure: null,
  ...over,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- the composer ------------------------------------------------------------------------------------

describe("MessageComposer in an email conversation", () => {
  it("makes Reply an email: its own label, placeholder and a hint of who it goes to (display only)", () => {
    render(
      <MessageComposer
        resolved={false}
        onSend={vi.fn()}
        emailReply={{ to: "eve@customer.test" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Send email" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/email reply to the customer/i)).toBeInTheDocument();
    expect(screen.getByText(/sent as an email to eve@customer.test/i)).toBeInTheDocument();
    expect(screen.getByText(/internal notes are never emailed/i)).toBeInTheDocument();
  });

  it("sends the email input with a fresh idempotency key per reply, and no recipient or sender", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageComposer resolved={false} onSend={onSend} emailReply={{ to: "eve@customer.test" }} />,
    );
    await user.type(screen.getByRole("textbox"), "First");
    await user.click(screen.getByRole("button", { name: "Send email" }));
    await user.type(screen.getByRole("textbox"), "Second");
    await user.click(screen.getByRole("button", { name: "Send email" }));

    const [first, second] = onSend.mock.calls.map(([input]) => input);
    expect(first).toMatchObject({ body: "First", type: "MESSAGE", from: "USER", viaEmail: true });
    expect(first.clientMessageId).toMatch(UUID);
    expect(second.clientMessageId).toMatch(UUID);
    expect(second.clientMessageId).not.toBe(first.clientMessageId);
    for (const input of [first, second]) {
      expect(Object.keys(input).sort()).toEqual([
        "body",
        "clientMessageId",
        "from",
        "type",
        "viaEmail",
      ]);
    }
  });

  it("an internal note and a logged customer message are NOT emails, even in an email conversation", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(
      <MessageComposer resolved={false} onSend={onSend} emailReply={{ to: "eve@customer.test" }} />,
    );
    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.queryByText(/sent as an email/i)).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "Careful");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await user.click(screen.getByRole("radio", { name: "Log customer message" }));
    await user.type(screen.getByRole("textbox"), "They called");
    await user.click(screen.getByRole("button", { name: "Log message" }));

    expect(onSend).toHaveBeenNthCalledWith(1, {
      body: "Careful",
      type: "INTERNAL_NOTE",
      from: "USER",
    });
    expect(onSend).toHaveBeenNthCalledWith(2, {
      body: "They called",
      type: "MESSAGE",
      from: "CUSTOMER",
    });
  });

  it("other channels are unchanged: no email wording, no key", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved={false} onSend={onSend} />);
    expect(screen.queryByText(/sent as an email/i)).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "Hi");
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(onSend).toHaveBeenCalledWith({ body: "Hi", type: "MESSAGE", from: "USER" });
  });
});

// ---- the timeline: every delivery state, in plain words -------------------------------------------------

describe("ConversationTimeline: email delivery state", () => {
  const render1 = (emailDelivery: EmailDeliveryJson | null, extra: Partial<MessageJson> = {}) =>
    render(
      <ConversationTimeline
        names={new Map()}
        events={[]}
        messages={[
          {
            id: "m1",
            senderType: "USER",
            messageType: "MESSAGE",
            body: "Your order shipped",
            createdAt: new Date("2026-01-01T10:00:00Z"),
            sender: { id: "u1", name: "Dana", email: "d@x.test" },
            emailDelivery,
            ...extra,
          },
        ]}
      />,
    );
  const line = () => screen.getByLabelText(/^email delivery:/i);

  it.each([
    ["queued", delivery({ state: "queued" }), /queued to send/i],
    ["sending", delivery({ state: "sending" }), /sending by email/i],
    [
      "retrying",
      delivery({ state: "retrying", retryAt: "2026-01-01T10:05:00.000Z" }),
      /temporary problem, retrying/i,
    ],
  ])("%s is shown as in progress (not as success or failure)", (state, value, text) => {
    render1(value);
    expect(line()).toHaveTextContent(text);
    expect(line()).toHaveAttribute("data-delivery-state", state);
    expect(line()).toHaveAttribute("role", "status");
    expect(line()).not.toHaveTextContent(/not sent|accepted|unknown/i);
  });

  it("retrying shows when the next attempt is due", () => {
    render1(delivery({ state: "retrying", retryAt: "2026-01-01T10:05:00.000Z" }));
    expect(line()).toHaveTextContent(/next attempt around/i);
  });

  it("accepted says the PROVIDER accepted it and that delivery is not confirmed (never 'delivered')", () => {
    render1(delivery({ state: "accepted", acceptedAt: "2026-01-01T10:00:05.000Z" }));
    expect(line()).toHaveTextContent(/accepted by the mail provider/i);
    expect(line()).toHaveTextContent(/not confirmed/i);
    expect(line()).not.toHaveTextContent(/\bdelivered\b/i);
    expect(line()).not.toHaveTextContent(/failed|unknown/i);
  });

  it.each([
    ["rejected", /provider refused it/i],
    ["retries_exhausted", /several attempts/i],
    ["sender_unavailable", /switched off or changed/i],
    ["message_missing", /could not be found/i],
  ] as const)("failed (%s) is a clear failure with the reason, as an alert", (failure, reason) => {
    render1(delivery({ state: "failed", failedAt: "2026-01-01T10:00:05.000Z", failure }));
    expect(line()).toHaveTextContent(/email not sent/i);
    expect(line()).toHaveTextContent(reason);
    expect(line()).toHaveAttribute("role", "alert");
    expect(line()).not.toHaveTextContent(/accepted|unknown/i);
  });

  it("UNKNOWN is shown as uncertain: neither success nor confirmed failure, and warns against blind resending", () => {
    render1(delivery({ state: "unknown" }));
    expect(line()).toHaveTextContent(/outcome unknown/i);
    expect(line()).toHaveTextContent(/may or may not have been delivered/i);
    expect(line()).toHaveTextContent(/check before sending it again/i);
    expect(line()).toHaveAttribute("data-delivery-state", "unknown");
    expect(line()).not.toHaveTextContent(/accepted|not sent|\bfailed\b/i);
  });

  it("shows nothing for a message with no delivery (other channels, notes)", () => {
    render1(null);
    expect(screen.queryByLabelText(/^email delivery:/i)).not.toBeInTheDocument();
  });

  it("an internal note never shows a delivery line, even if one were attached", () => {
    render1(delivery({ state: "accepted" }), { messageType: "INTERNAL_NOTE" });
    expect(screen.queryByLabelText(/^email delivery:/i)).not.toBeInTheDocument();
    expect(screen.getByText(/only visible to your team/i)).toBeInTheDocument();
  });

  it("a customer message never shows a delivery line", () => {
    render1(delivery({ state: "accepted" }), { senderType: "CUSTOMER" });
    expect(screen.getByRole("article", { name: "Customer message" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/^email delivery:/i)).not.toBeInTheDocument();
  });

  it("is separate from the browser-side 'sending/sent' indicator of the request itself", () => {
    render1(delivery({ state: "queued" }), { delivery: "sent" } as never);
    expect(screen.getByRole("img", { name: "Sent" })).toBeInTheDocument();
    expect(line()).toHaveTextContent(/queued to send/i);
  });
});

// ---- the pane: the real flow against a mocked API ------------------------------------------------------

const emailConversation = conversation({
  channel: "EMAIL",
  customer: {
    id: "cust1",
    name: "Eve Example",
    email: "eve@customer.test",
    company: null,
    status: "ACTIVE",
  },
});
const initial = {
  conversation: { conversation: emailConversation },
  messages: {
    items: [
      message({ id: "in1", senderType: "CUSTOMER", sender: null, body: "Where is my order?" }),
    ],
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
const baseRoutes = (messages: () => object) => ({
  "GET /api/conversations/c1/messages": () => json(200, messages()),
  "GET /api/conversations/c1/events": () => json(200, initial.events),
  "GET /api/conversations/c1": () => json(200, initial.conversation),
  "GET /api/conversations?": () =>
    json(200, { items: [], page: 1, pageSize: 25, total: 0, totalPages: 1 }),
  "POST /api/conversations/c1/read": () => json(200, initial.conversation),
});

describe("ConversationPane: replying by email", () => {
  it("posts ONLY the text and a key to the email endpoint, then shows the persisted delivery state", async () => {
    const saved = message({ id: "m-out", body: "Shipped today", senderType: "USER" });
    let persisted: MessageJson[] = [];
    const api = mockApi({
      ...baseRoutes(() => ({
        ...initial.messages,
        items: [...initial.messages.items, ...persisted],
      })),
      "POST /api/conversations/c1/email-reply": () => {
        persisted = [{ ...saved, emailDelivery: delivery({ state: "queued" }) }];
        return json(201, {
          message: saved,
          delivery: delivery({ state: "queued" }),
          duplicate: false,
        });
      },
    });
    const user = userEvent.setup();
    renderPane();
    expect(screen.getByText(/sent as an email to eve@customer.test/i)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox"), "Shipped today");
    await user.click(screen.getByRole("button", { name: "Send email" }));

    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/email-reply")).toBe(1));
    const call = api.calls.find((c) => c.method === "POST" && c.url.endsWith("/email-reply"))!;
    expect(Object.keys(call.body as object).sort()).toEqual(["body", "clientMessageId"]);
    expect(call.body).toMatchObject({ body: "Shipped today" });
    expect((call.body as { clientMessageId: string }).clientMessageId).toMatch(UUID);
    // Never to the plain endpoint.
    expect(api.count("POST", "/api/conversations/c1/messages")).toBe(0);

    const bubble = await screen.findByRole("article", { name: "Agent message" });
    expect(await within(bubble).findByLabelText(/email delivery: queued/i)).toBeInTheDocument();
    expect(screen.getAllByText("Shipped today")).toHaveLength(1);
  });

  it("a failed request can be retried and the retry reuses the SAME idempotency key", async () => {
    let attempt = 0;
    const api = mockApi({
      ...baseRoutes(() => initial.messages),
      "POST /api/conversations/c1/email-reply": () => {
        attempt += 1;
        return attempt === 1
          ? apiError(500, "internal_error", "Boom")
          : json(200, {
              message: message({ id: "m-out", body: "Please retry me" }),
              delivery: delivery(),
              duplicate: true,
            });
      },
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "Please retry me");
    await user.click(screen.getByRole("button", { name: "Send email" }));
    expect(await screen.findByRole("img", { name: "Failed to send" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/email-reply")).toBe(2));

    const keys = api.calls
      .filter((c) => c.method === "POST" && c.url.endsWith("/email-reply"))
      .map((c) => (c.body as { clientMessageId: string }).clientMessageId);
    expect(keys[0]).toMatch(UUID);
    expect(keys[1]).toBe(keys[0]);
  });

  it("an internal note in an email conversation goes to the plain endpoint without a key", async () => {
    const api = mockApi({
      ...baseRoutes(() => initial.messages),
      "POST /api/conversations/c1/messages": () =>
        json(201, {
          message: message({ id: "n1", messageType: "INTERNAL_NOTE", body: "Careful" }),
        }),
    });
    const user = userEvent.setup();
    renderPane();
    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    await user.type(screen.getByRole("textbox"), "Careful");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/messages")).toBe(1));
    expect(api.count("POST", "/api/conversations/c1/email-reply")).toBe(0);
    const call = api.calls.find((c) => c.method === "POST" && c.url.endsWith("/messages"))!;
    expect(call.body).toEqual({ body: "Careful", type: "INTERNAL_NOTE", from: "USER" });
  });

  it("shows the server's reason when email cannot be sent (settings off, no address)", async () => {
    mockApi({
      ...baseRoutes(() => initial.messages),
      "POST /api/conversations/c1/email-reply": () =>
        apiError(409, "conflict", "Email is not set up for this organization"),
    });
    const user = userEvent.setup();
    renderPane();
    await user.type(screen.getByRole("textbox"), "Hello");
    await user.click(screen.getByRole("button", { name: "Send email" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/email is not set up/i);
  });

  it("a non-email conversation keeps the plain reply flow and wording", async () => {
    const plainInitial = {
      ...initial,
      conversation: { conversation: conversation({ channel: "IN_APP" }) },
    } as typeof initial;
    mockApi({
      ...baseRoutes(() => plainInitial.messages),
      "GET /api/conversations/c1": () => json(200, plainInitial.conversation),
    });
    renderWithQuery(
      <ConversationPane
        conversationId="c1"
        initial={plainInitial}
        currentUserId="me"
        can={{ update: true, assign: false, send: true }}
        closeHref="/inbox"
      />,
    );
    expect(screen.getByRole("button", { name: "Send reply" })).toBeInTheDocument();
    expect(screen.queryByText(/sent as an email/i)).not.toBeInTheDocument();
  });
});

// ---- refreshing a delivery that is still in flight -----------------------------------------------------

describe("message list refresh while a delivery is in flight", () => {
  const items = (state: EmailDeliveryJson["state"]) => ({
    items: [{ ...message({ id: "m1" }), emailDelivery: delivery({ state }) }],
    hasMore: false,
    nextCursor: null,
    total: 1,
  });

  it("re-reads on an interval while queued/sending/retrying and stops once settled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let state: EmailDeliveryJson["state"] = "queued";
    const api = mockApi({ "GET /api/conversations/c1/messages": () => json(200, items(state)) });
    renderHookWithQuery(() => useConversationMessages("c1", { limit: 50, includeInternal: true }));
    await vi.waitFor(() => expect(api.count("GET", "/api/conversations/c1/messages")).toBe(1));

    state = "sending";
    await vi.advanceTimersByTimeAsync(DELIVERY_REFRESH_MS + 100);
    await vi.waitFor(() => expect(api.count("GET", "/api/conversations/c1/messages")).toBe(2));

    state = "accepted";
    await vi.advanceTimersByTimeAsync(DELIVERY_REFRESH_MS + 100);
    await vi.waitFor(() => expect(api.count("GET", "/api/conversations/c1/messages")).toBe(3));

    // Settled: no more polling.
    await vi.advanceTimersByTimeAsync(DELIVERY_REFRESH_MS * 3);
    expect(api.count("GET", "/api/conversations/c1/messages")).toBe(3);
  });

  it("never polls a list that has no email delivery at all (other channels)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = mockApi({
      "GET /api/conversations/c1/messages": () =>
        json(200, { items: [message()], hasMore: false, nextCursor: null, total: 1 }),
    });
    renderHookWithQuery(() => useConversationMessages("c1", { limit: 50, includeInternal: true }));
    await vi.waitFor(() => expect(api.count("GET", "/api/conversations/c1/messages")).toBe(1));
    await vi.advanceTimersByTimeAsync(DELIVERY_REFRESH_MS * 3);
    expect(api.count("GET", "/api/conversations/c1/messages")).toBe(1);
  });

  it("UNKNOWN and FAILED are settled (nothing will change by itself), so they are not polled", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    for (const state of ["unknown", "failed"] as const) {
      const api = mockApi({ "GET /api/conversations/c1/messages": () => json(200, items(state)) });
      const { unmount } = renderHookWithQuery(() =>
        useConversationMessages("c1", { limit: 50, includeInternal: true }),
      );
      await vi.waitFor(() => expect(api.count("GET", "/api/conversations/c1/messages")).toBe(1));
      await vi.advanceTimersByTimeAsync(DELIVERY_REFRESH_MS * 3);
      expect(api.count("GET", "/api/conversations/c1/messages")).toBe(1);
      unmount();
    }
  });
});
