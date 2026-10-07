// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiError,
  deferred,
  json,
  mockApi,
  renderWithQuery,
} from "../../../../tests/helpers/query";
import type { ApprovalJson } from "../api/types";
import { AiApprovalCards } from "./ai-approval-cards";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const approval = (overrides: Partial<ApprovalJson> = {}): ApprovalJson => ({
  id: "a1",
  conversationId: "c1",
  toolName: "changeConversationStatus",
  riskLevel: "MEDIUM",
  status: "PENDING",
  preview: {
    title: "Change conversation status",
    lines: [
      { label: "Conversation", from: null, to: "Billing help" },
      { label: "Status", from: "Open", to: "Resolved" },
    ],
  },
  requestedByUserId: "u1",
  createdAt: "2026-01-01T10:00:00.000Z",
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  failureCode: null,
  ...overrides,
});

const decided = (status: ApprovalJson["status"], extra: Partial<ApprovalJson> = {}) =>
  json(200, { approval: approval({ status, ...extra }) });
const emptyList = () => json(200, { approvals: [] });

function renderCards(initial: ApprovalJson[]) {
  return renderWithQuery(<AiApprovalCards conversationId="c1" initial={initial} />);
}

describe("AiApprovalCards", () => {
  it("renders nothing when no action is pending", () => {
    mockApi({});
    renderCards([]);
    expect(screen.queryByRole("region", { name: "AI action requires approval" })).toBeNull();
  });

  it("shows exactly what will happen, with Approve and Reject", () => {
    mockApi({});
    renderCards([approval()]);
    const card = screen.getByRole("region", { name: "AI action requires approval" });
    expect(card).toHaveTextContent("Change conversation status");
    expect(card).toHaveTextContent("Billing help");
    expect(card).toHaveTextContent(/Status:\s*Open\s*→\s*changes to\s*Resolved/);
    expect(within(card).getByRole("button", { name: "Approve" })).toBeEnabled();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeEnabled();
  });

  it("describes a customer change field by field", () => {
    mockApi({});
    renderCards([
      approval({
        toolName: "updateCustomer",
        preview: {
          title: "Update customer John Doe",
          lines: [{ label: "Company", from: "Acme", to: "Acme Inc." }],
        },
      }),
    ]);
    const card = screen.getByRole("region", { name: "AI action requires approval" });
    expect(card).toHaveTextContent("Update customer John Doe");
    expect(card).toHaveTextContent(/Company:\s*Acme\s*→\s*changes to\s*Acme Inc\./);
  });

  it("Approve shows a loading state, calls the server once even on double click, then the result", async () => {
    const gate = deferred<Response>();
    const api = mockApi({
      "POST /api/ai-approvals/a1/approve": () => gate.promise,
      "GET /api/conversations/c1/ai-approvals": emptyList,
    });
    const user = userEvent.setup();
    renderCards([approval()]);
    const card = screen.getByRole("region", { name: "AI action requires approval" });

    await user.click(within(card).getByRole("button", { name: "Approve" }));
    const busy = await within(card).findByRole("button", { name: "Approving..." });
    expect(busy).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Reject" })).toBeDisabled();
    await user.click(busy);
    expect(api.count("POST", "/api/ai-approvals/a1/approve")).toBe(1);

    gate.resolve(decided("EXECUTED"));
    expect(await screen.findByText("Approved and applied.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(api.count("POST", "/api/ai-approvals/a1/approve")).toBe(1);
    // The pending list is refreshed from the server afterwards.
    await waitFor(() => expect(api.count("GET", "/api/conversations/c1/ai-approvals")).toBe(1));
  });

  it("Reject sends the rejection and says nothing was changed", async () => {
    const api = mockApi({
      "POST /api/ai-approvals/a1/reject": () => decided("REJECTED"),
      "GET /api/conversations/c1/ai-approvals": emptyList,
    });
    const user = userEvent.setup();
    renderCards([approval()]);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    expect(await screen.findByText("Rejected. Nothing was changed.")).toBeInTheDocument();
    expect(api.count("POST", "/api/ai-approvals/a1/reject")).toBe(1);
    expect(api.count("POST", "/api/ai-approvals/a1/approve")).toBe(0);
  });

  it("an expired action cannot be approved or rejected from the UI", () => {
    const api = mockApi({});
    renderCards([approval({ expiresAt: new Date(Date.now() - 1000).toISOString() })]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(/Expired/);
    expect(api.calls).toHaveLength(0);
  });

  it("the server's refusal (expired / already handled / forbidden) is shown and the card stays usable", async () => {
    mockApi({
      "POST /api/ai-approvals/a1/approve": () =>
        apiError(409, "approval_expired", "This approval has expired. Ask the AI again."),
      "GET /api/conversations/c1/ai-approvals": () => json(200, { approvals: [approval()] }),
    });
    const user = userEvent.setup();
    renderCards([approval()]);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This approval has expired");
    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled());
  });

  it("a failed execution is reported plainly", async () => {
    mockApi({
      "POST /api/ai-approvals/a1/approve": () =>
        decided("FAILED", { failureCode: "EXECUTION_FAILED" }),
      "GET /api/conversations/c1/ai-approvals": emptyList,
    });
    const user = userEvent.setup();
    renderCards([approval()]);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByText(/could not be applied/)).toBeInTheDocument();
  });

  it("a settled card can be dismissed", async () => {
    mockApi({
      "POST /api/ai-approvals/a1/reject": () => decided("REJECTED"),
      "GET /api/conversations/c1/ai-approvals": emptyList,
    });
    const user = userEvent.setup();
    renderCards([approval()]);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("region", { name: "AI action requires approval" })).toBeNull();
    expect(screen.queryByRole("region", { name: "AI action" })).toBeNull();
  });
});
