// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, mockApi, renderWithQuery } from "../../../../tests/helpers/query";
import { PortalInfoProvider } from "../portal-context";
import { ConversationDetail } from "./conversation-detail";
import { ConversationListView } from "./conversation-list-view";
import { HelpArticleView, HelpCenter } from "./help-center";
import { JoinView } from "./join-view";
import { NewConversationForm } from "./new-conversation-form";
import { PortalHome } from "./portal-home";
import { ProfileView } from "./profile-view";

const push = vi.fn();
let search = "token=pi_test_token_value_1234567890";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search),
  usePathname: () => "/portal/acme",
}));

afterEach(() => {
  cleanup();
  push.mockClear();
  search = "token=pi_test_token_value_1234567890";
  vi.unstubAllGlobals();
});

const CID = "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01";
const conversation = (overrides: Record<string, unknown> = {}) => ({
  id: CID,
  subject: "Invoice problem",
  status: "OPEN",
  lastMessageAt: "2026-01-01T10:00:00.000Z",
  lastMessagePreview: "My invoice is wrong",
  lastMessageFrom: "customer",
  humanRequested: false,
  assistant: "none",
  createdAt: "2026-01-01T09:00:00.000Z",
  ...overrides,
});
const message = (
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
  authorName: from === "team" ? "Sam" : null,
  handoffSuggested: false,
  ...extra,
});

function renderPortal(ui: React.ReactElement) {
  return renderWithQuery(
    <PortalInfoProvider info={{ slug: "acme", name: "Acme" }}>{ui}</PortalInfoProvider>,
  );
}

describe("portal home", () => {
  it("shows the summary and recent conversations of the signed-in customer", async () => {
    mockApi({
      "GET /api/portal/acme/summary": () =>
        json(200, {
          organization: { name: "Acme", slug: "acme" },
          total: 4,
          open: 2,
          recent: [conversation()],
        }),
    });
    renderPortal(<PortalHome />);
    expect(await screen.findByText("Invoice problem")).toBeTruthy();
    expect(screen.getByText("Open conversations").nextElementSibling?.textContent).toBe("2");
    expect(
      screen.getByRole("link", { name: "New support conversation" }).getAttribute("href"),
    ).toBe("/portal/acme/conversations/new");
    expect(screen.getByRole("link", { name: "Open help center" })).toBeTruthy();
  });

  it("empty state, error with retry, and a not-linked explanation", async () => {
    const user = userEvent.setup();
    let calls = 0;
    mockApi({
      "GET /api/portal/acme/summary": () => {
        calls += 1;
        if (calls === 1) return apiError(500, "internal_error", "boom");
        if (calls === 2)
          return json(200, {
            organization: { name: "Acme", slug: "acme" },
            total: 0,
            open: 0,
            recent: [],
          });
        return apiError(
          403,
          "portal_not_linked",
          "Your account is not linked to a customer profile",
        );
      },
    });
    const { client } = renderPortal(<PortalHome />);
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
    await client.invalidateQueries();
    expect(await screen.findByText("Your account is not linked yet")).toBeTruthy();
    expect(screen.queryByText("No conversations yet")).toBeNull();
  });
});

describe("conversation list", () => {
  it("paginates and links to each conversation", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/portal/acme/conversations": (url) =>
        url.includes("page=2")
          ? json(200, {
              items: [conversation({ id: "c2", subject: "Second page" })],
              total: 11,
              page: 2,
              pageSize: 10,
            })
          : json(200, { items: [conversation()], total: 11, page: 1, pageSize: 10 }),
    });
    renderPortal(<ConversationListView />);
    const link = (await screen.findByText("Invoice problem")).closest("a");
    expect(link?.getAttribute("href")).toBe(`/portal/acme/conversations/${CID}`);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText("Second page")).toBeTruthy();
    expect(api.calls.some((c) => c.url.includes("page=2"))).toBe(true);
  });

  it("empty state", async () => {
    mockApi({
      "GET /api/portal/acme/conversations": () =>
        json(200, { items: [], total: 0, page: 1, pageSize: 10 }),
    });
    renderPortal(<ConversationListView />);
    expect(await screen.findByText("No conversations yet")).toBeTruthy();
  });
});

describe("conversation detail", () => {
  it("distinguishes customer, AI and support messages and shows the status", async () => {
    mockApi({
      "GET /api/portal/acme/conversations/": () =>
        json(200, {
          conversation: conversation({ assistant: "ai", status: "PENDING" }),
          messages: [
            message("m1", "visitor", "Help"),
            message("m2", "ai", "Here is help"),
            message("m3", "team", "Hi, Sam here"),
          ],
        }),
    });
    renderPortal(<ConversationDetail conversationId={CID} />);
    expect(await screen.findByText("Hi, Sam here")).toBeTruthy();
    expect(screen.getByText("AI assistant")).toBeTruthy();
    expect(screen.getByText("Sam · Support team")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
  });

  it("sends a message with a client id; a failed send keeps the text and Retry reuses the same id", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const api = mockApi({
      "POST /api/portal/acme/conversations/": () => {
        attempts += 1;
        return attempts === 1
          ? apiError(500, "internal_error", "boom")
          : json(201, { message: message("m9", "visitor", "More details") });
      },
      "GET /api/portal/acme/conversations/": () =>
        json(200, { conversation: conversation(), messages: [message("m1", "visitor", "Help")] }),
    });
    renderPortal(<ConversationDetail conversationId={CID} />);
    await user.type(await screen.findByLabelText("Your message"), "More details");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Retry" }));
    await waitFor(() => expect(attempts).toBe(2));
    const sends = api.calls.filter((c) => c.method === "POST");
    expect(sends[0].body).toMatchObject({ body: "More details" });
    expect((sends[0].body as { clientMessageId: string }).clientMessageId).toBe(
      (sends[1].body as { clientMessageId: string }).clientMessageId,
    );
    // Only the message fields are sent: no sender, customer or organization.
    expect(Object.keys(sends[0].body as object).sort()).toEqual(["body", "clientMessageId"]);
  });

  it("shows exactly one handoff action, then a status; none after a person took over", async () => {
    const user = userEvent.setup();
    let requested = false;
    mockApi({
      "POST /api/portal/acme/conversations/": () => {
        requested = true;
        return json(200, { humanRequested: true });
      },
      "GET /api/portal/acme/conversations/": () =>
        json(200, {
          conversation: conversation({
            assistant: requested ? "human" : "ai",
            humanRequested: requested,
            lastMessageFrom: "ai",
          }),
          messages: [
            message("m1", "visitor", "Help"),
            message("m2", "ai", "I could not find that. Would you like a person?", {
              handoffSuggested: true,
            }),
          ],
        }),
    });
    renderPortal(<ConversationDetail conversationId={CID} />);
    const action = await screen.findByRole("button", { name: "Talk to a person" });
    expect(screen.getAllByRole("button", { name: "Talk to a person" })).toHaveLength(1);
    await user.click(action);
    await waitFor(() =>
      expect(screen.getAllByText("A support agent has been requested.")).toHaveLength(1),
    );
    expect(screen.queryByRole("button", { name: "Talk to a person" })).toBeNull();
  });

  it("shows AI is thinking only while the AI is expected to answer", async () => {
    mockApi({
      "GET /api/portal/acme/conversations/": () =>
        json(200, {
          conversation: conversation({ assistant: "ai" }),
          messages: [message("m1", "visitor", "Help")],
        }),
    });
    renderPortal(<ConversationDetail conversationId={CID} />);
    expect(await screen.findByText("AI is thinking…")).toBeTruthy();
  });

  it("another customer's conversation is a plain not-found state", async () => {
    mockApi({
      "GET /api/portal/acme/conversations/": () =>
        apiError(404, "not_found", "Conversation not found"),
    });
    renderPortal(<ConversationDetail conversationId={CID} />);
    expect(await screen.findByText("We could not find that.")).toBeTruthy();
  });
});

describe("new conversation", () => {
  it("creates it with an idempotency id and no customer or organization fields, then opens it", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "POST /api/portal/acme/conversations": () =>
        json(201, { conversation: conversation({ id: CID }), messages: [] }),
    });
    renderPortal(<NewConversationForm />);
    await user.type(screen.getByLabelText("Subject"), "Invoice problem");
    await user.type(screen.getByLabelText("How can we help?"), "My invoice is wrong");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/portal/acme/conversations/${CID}`));
    expect(Object.keys(api.calls[0].body as object).sort()).toEqual([
      "body",
      "clientMessageId",
      "subject",
    ]);
  });
});

describe("help center", () => {
  it("browses, searches, shows no-results and opens an article as plain text", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/portal/acme/help": (url) =>
        url.includes("q=zzz")
          ? json(200, { items: [], total: 0, page: 1, pageSize: 10 })
          : json(200, {
              items: [
                {
                  id: CID,
                  title: "Refund policy",
                  summary: "Refunds within 30 days",
                  publishedAt: null,
                },
              ],
              total: 1,
              page: 1,
              pageSize: 10,
            }),
    });
    renderPortal(<HelpCenter />);
    expect(await screen.findByText("Refund policy")).toBeTruthy();
    await user.type(screen.getByLabelText("Search articles"), "zzz");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("No articles found")).toBeTruthy();
    expect(api.calls.some((c) => c.url.includes("q=zzz"))).toBe(true);
  });

  it("renders article content as text, never as HTML", async () => {
    mockApi({
      "GET /api/portal/acme/help/": () =>
        json(200, {
          article: {
            id: CID,
            title: "Refund policy",
            summary: "s",
            publishedAt: null,
            content: "<img src=x onerror=alert(1)> Refunds within 30 days",
          },
        }),
    });
    const { container } = renderPortal(<HelpArticleView articleId={CID} />);
    expect(await screen.findByText(/Refunds within 30 days/)).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("profile", () => {
  const profile = {
    firstName: "Alice",
    lastName: "Anders",
    email: "alice@a.test",
    phone: null,
    company: "Acme",
  };

  it("edits the permitted fields; the email is read-only and never sent", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /api/portal/acme/profile": () => json(200, { profile }),
      "PATCH /api/portal/acme/profile": () =>
        json(200, { profile: { ...profile, firstName: "Alicia" } }),
    });
    renderPortal(<ProfileView />);
    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    expect(email.disabled).toBe(true);
    const first = screen.getByLabelText("First name");
    await user.clear(first);
    await user.type(first, "Alicia");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("Saved.");
    const patch = api.calls.find((c) => c.method === "PATCH");
    expect(Object.keys(patch?.body as object).sort()).toEqual(["firstName", "lastName", "phone"]);
  });

  it("shows server validation errors per field", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/portal/acme/profile": () => json(200, { profile }),
      "PATCH /api/portal/acme/profile": () =>
        json(400, {
          error: {
            code: "validation_error",
            message: "Invalid request",
            details: [{ path: "phone", message: "Enter a valid phone number" }],
          },
        }),
    });
    renderPortal(<ProfileView />);
    await user.type(await screen.findByLabelText("Phone"), "abc");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Enter a valid phone number")).toBeTruthy();
  });
});

describe("join (invitation)", () => {
  it("redeems the token from the link and reports success", async () => {
    const user = userEvent.setup();
    let linked = false;
    const api = mockApi({
      "GET /api/portal/acme/me": () =>
        json(200, { organization: { name: "Acme", slug: "acme" }, linked }),
      "POST /api/portal/acme/join": () => {
        linked = true;
        return json(200, { linked: true, alreadyLinked: false });
      },
    });
    renderPortal(<JoinView />);
    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByText("You are connected")).toBeTruthy();
    expect(api.calls.find((c) => c.method === "POST")?.body).toEqual({
      token: "pi_test_token_value_1234567890",
    });
  });

  it("explains an email mismatch and a missing token", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /api/portal/acme/me": () =>
        json(200, { organization: { name: "Acme", slug: "acme" }, linked: false }),
      "POST /api/portal/acme/join": () => apiError(403, "invite_email_mismatch", "different email"),
    });
    renderPortal(<JoinView />);
    await user.click(await screen.findByRole("button", { name: "Accept invitation" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText(/sent to a different email address/)).toBeTruthy();
    cleanup();
    search = "";
    renderPortal(<JoinView />);
    expect(await screen.findByText(/invitation link is incomplete/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Accept invitation" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
