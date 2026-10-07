// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationControls } from "./conversation-controls";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
});
afterEach(() => {
  cleanup();
  fetchMock.mockReset();
  refresh.mockReset();
  vi.unstubAllGlobals();
});

const members = [
  { id: "me", label: "Me" },
  { id: "other", label: "Other" },
];

const base = {
  conversationId: "c1",
  status: "OPEN" as const,
  priority: "NORMAL" as const,
  assigneeId: null,
  currentUserId: "me",
  members,
  canUpdate: true,
  canAssignOthers: false,
};

describe("ConversationControls", () => {
  it("offers only valid status transitions", () => {
    const { rerender } = render(<ConversationControls {...base} status="OPEN" />);
    const options = () =>
      within(screen.getByLabelText("Status"))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(options()).toEqual(["Open", "Pending", "Resolved"]);
    rerender(<ConversationControls {...base} status="RESOLVED" />);
    expect(options()).toEqual(["Resolved", "Open"]);
  });

  it("patches the status and refreshes", async () => {
    const user = userEvent.setup();
    render(<ConversationControls {...base} />);
    await user.selectOptions(screen.getByLabelText("Status"), "RESOLVED");
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1");
    expect(fetchMock.mock.calls[0][1].method).toBe("PATCH");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ status: "RESOLVED" });
  });

  it("lets a member claim an unassigned conversation, but not reassign others", async () => {
    const user = userEvent.setup();
    render(<ConversationControls {...base} />);
    expect(screen.queryByLabelText("Assignee")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Assign to me" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/assign");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ userId: "me" });
  });

  it("shows read-only text when someone else holds the conversation (member view)", () => {
    render(<ConversationControls {...base} assigneeId="other" />);
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /assign|unassign/i })).not.toBeInTheDocument();
  });

  it("gives admins a full assignee picker including unassign", async () => {
    const user = userEvent.setup();
    render(<ConversationControls {...base} canAssignOthers assigneeId="me" />);
    const select = screen.getByLabelText("Assignee");
    await user.selectOptions(select, "other");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ userId: "other" });
    await user.selectOptions(select, "");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe("/api/conversations/c1/unassign");
  });

  it("disables editing without permission and surfaces API errors", async () => {
    const { rerender } = render(<ConversationControls {...base} canUpdate={false} />);
    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Priority")).toBeDisabled();

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Cannot change status from RESOLVED to PENDING" } }),
        {
          status: 409,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    rerender(<ConversationControls {...base} />);
    await userEvent.setup().selectOptions(screen.getByLabelText("Priority"), "URGENT");
    expect(await screen.findByRole("alert")).toHaveTextContent("Cannot change status");
    expect(refresh).not.toHaveBeenCalled();
  });
});
