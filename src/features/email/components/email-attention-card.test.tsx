// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, mockApi, renderWithQuery } from "../../../../tests/helpers/query";
import { EmailAttentionCard } from "./email-attention-card";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (over: Record<string, unknown> = {}) => ({
  id: "3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01",
  conversationId: "c-1",
  messageId: "m-1",
  category: "unknown",
  state: "unknown",
  since: "2026-01-01T10:00:00.000Z",
  failure: null,
  recipient: "e***@customer.test",
  canRecheck: true,
  ...over,
});
const page = (items: object[], over: Record<string, unknown> = {}) => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 10,
  summary: { queued_overdue: 0, retry_overdue: 0, lease_expired: 0, unknown: 0, failed: 0 },
  ...over,
});
const URL = "GET /api/email-outbound/attention";

describe("EmailAttentionCard", () => {
  it("says nothing needs attention, and explains that ordinary queued or retrying email is not listed", async () => {
    mockApi({ [URL]: () => json(200, page([])) });
    renderWithQuery(<EmailAttentionCard />);
    expect(await screen.findByText("Nothing needs attention")).toBeInTheDocument();
    expect(
      screen.getByText(/queued or waiting for a scheduled\s+retry is normal/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: /needing attention/i })).not.toBeInTheDocument();
  });

  it("lists each overdue, stalled, unknown and failed email in plain words, with a masked recipient and a link", async () => {
    mockApi({
      [URL]: () =>
        json(
          200,
          page(
            [
              item({ id: "u1" }),
              item({
                id: "q1",
                category: "queued_overdue",
                state: "queued",
                canRecheck: false,
                conversationId: "c-2",
              }),
              item({ id: "r1", category: "retry_overdue", state: "retrying", canRecheck: false }),
              item({ id: "l1", category: "lease_expired", state: "sending", canRecheck: false }),
              item({
                id: "f1",
                category: "failed",
                state: "failed",
                failure: "rejected",
                canRecheck: false,
              }),
            ],
            {
              summary: {
                queued_overdue: 1,
                retry_overdue: 1,
                lease_expired: 1,
                unknown: 1,
                failed: 1,
              },
            },
          ),
        ),
    });
    renderWithQuery(<EmailAttentionCard />);
    const list = await screen.findByRole("list", { name: /emails needing attention/i });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(5);
    for (const label of [
      "Waiting to send, overdue",
      "Retry overdue",
      "Stalled while sending",
      "Outcome unknown",
      "Failed",
    ]) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
    expect(within(list).getAllByText(/to e\*\*\*@customer\.test/)).toHaveLength(5);
    expect(screen.queryByText(/eve@customer/)).not.toBeInTheDocument();
    expect(within(rows[1]).getByRole("link", { name: /open conversation/i })).toHaveAttribute(
      "href",
      expect.stringContaining("c=c-2"),
    );
  });

  it("explains that an unknown email is never resent and must not be sent again before checking", async () => {
    mockApi({
      [URL]: () =>
        json(
          200,
          page([item()], {
            summary: {
              queued_overdue: 0,
              retry_overdue: 0,
              lease_expired: 0,
              unknown: 1,
              failed: 0,
            },
          }),
        ),
    });
    renderWithQuery(<EmailAttentionCard />);
    expect(await screen.findByText(/never resent automatically/i)).toBeInTheDocument();
    expect(screen.getByText(/do not send it again before checking/i)).toBeInTheDocument();
  });

  it("offers ONLY 'Check with provider' for an unknown email: no resend and no way to mark anything sent or failed", async () => {
    mockApi({
      [URL]: () =>
        json(
          200,
          page([
            item(),
            item({
              id: "f1",
              category: "failed",
              state: "failed",
              failure: "rejected",
              canRecheck: false,
            }),
          ]),
        ),
    });
    renderWithQuery(<EmailAttentionCard />);
    await screen.findByRole("list", { name: /emails needing attention/i });
    expect(screen.getAllByRole("button", { name: /check with provider/i })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: /resend|retry now|send again|mark|confirm|resolve/i }),
    ).not.toBeInTheDocument();
  });

  it("when the provider cannot be asked it says so and offers no action", async () => {
    mockApi({ [URL]: () => json(200, page([item({ canRecheck: false })])) });
    renderWithQuery(<EmailAttentionCard />);
    expect(
      await screen.findByText(/cannot be asked about this email, so it stays unknown/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /check with provider/i })).not.toBeInTheDocument();
  });

  it.each([
    ["found", /recorded as accepted by the provider/i],
    ["no_record", /no record of it: recorded as not sent/i],
    ["unavailable", /could not answer\. It stays unknown/i],
    ["inconclusive", /too long ago for that to prove anything\. It stays unknown/i],
  ])("re-check outcome %s is described without overclaiming", async (outcome, text) => {
    const api = mockApi({
      [URL]: () => json(200, page([item()])),
      "POST /api/email-outbound/": () => json(200, { outcome, delivery: {} }),
    });
    const user = userEvent.setup();
    renderWithQuery(<EmailAttentionCard />);
    await user.click(await screen.findByRole("button", { name: /check with provider/i }));
    expect(await screen.findByRole("status")).toHaveTextContent(text);
    const post = api.calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/email-outbound/3f2b8c1e-6a4d-4b7e-9c10-2d5e7a8b9c01/recheck");
    expect(post.body).toBeUndefined(); // no body: the caller cannot choose an outcome
    expect(screen.getByRole("status")).not.toHaveTextContent(/delivered/i);
  });

  it("shows the server's reason when a re-check is refused", async () => {
    mockApi({
      [URL]: () => json(200, page([item()])),
      "POST /api/email-outbound/": () =>
        apiError(409, "conflict", "This was attempted too recently to be sure. Try again later"),
    });
    const user = userEvent.setup();
    renderWithQuery(<EmailAttentionCard />);
    await user.click(await screen.findByRole("button", { name: /check with provider/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/too recently/i);
  });

  it("paginates in bounded pages", async () => {
    const api = mockApi({
      [URL]: (url) =>
        json(
          200,
          page(url.includes("page=2") ? [item({ id: "p2" })] : [item({ id: "p1" })], {
            total: 12,
            page: url.includes("page=2") ? 2 : 1,
            pageSize: 10,
            summary: {
              queued_overdue: 0,
              retry_overdue: 0,
              lease_expired: 0,
              unknown: 12,
              failed: 0,
            },
          }),
        ),
    });
    const user = userEvent.setup();
    renderWithQuery(<EmailAttentionCard />);
    expect(await screen.findByText(/page 1 of 2/i)).toBeInTheDocument();
    expect(api.calls[0].url).toContain("pageSize=10");
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/page 2 of 2/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("renders nothing for a caller without permission, and offers a retry on other errors", async () => {
    mockApi({ [URL]: () => apiError(403, "forbidden", "Forbidden") });
    const { container } = renderWithQuery(<EmailAttentionCard />);
    await waitFor(() =>
      expect(screen.queryByText(/loading email delivery/i)).not.toBeInTheDocument(),
    );
    expect(container).toBeEmptyDOMElement();
    cleanup();

    mockApi({ [URL]: () => apiError(500, "internal_error", "Boom") });
    renderWithQuery(<EmailAttentionCard />);
    expect(await screen.findByText(/could not load email delivery/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
  });
});
