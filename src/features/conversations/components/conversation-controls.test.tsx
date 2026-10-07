// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { conversation } from "../../../../tests/helpers/fixtures";
import {
  apiError,
  deferred,
  json,
  mockApi,
  renderWithQuery,
} from "../../../../tests/helpers/query";
import type { ConversationJson } from "../api/types";
import { useConversation } from "../hooks/queries";
import { ConversationControls } from "./conversation-controls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const members = [
  { id: "me", label: "Me", email: "me@example.com", name: "Me" },
  { id: "other", label: "Other", email: "other@example.com", name: "Other" },
];

/**
 * The controls read the conversation from the query cache (as the real pane does), so these tests
 * observe the actual optimistic update and rollback on screen.
 */
function Harness({
  initial,
  canUpdate = true,
  canAssignOthers = false,
}: {
  initial: ConversationJson;
  canUpdate?: boolean;
  canAssignOthers?: boolean;
}) {
  const { data } = useConversation(initial.id, { initialData: { conversation: initial } });
  return (
    <ConversationControls
      conversation={data!.conversation}
      currentUserId="me"
      members={members}
      canUpdate={canUpdate}
      canAssignOthers={canAssignOthers}
    />
  );
}

const refetchRoutes = (c: ConversationJson) => ({
  "GET /api/conversations/c1": () => json(200, { conversation: c }),
  "GET /api/conversations?": () =>
    json(200, { items: [c], page: 1, pageSize: 25, total: 1, totalPages: 1 }),
  "GET /api/conversations/c1/events": () =>
    json(200, { items: [], page: 1, pageSize: 100, total: 0, totalPages: 1 }),
});

describe("ConversationControls", () => {
  it("offers only valid status transitions", () => {
    mockApi({});
    const { unmount } = renderWithQuery(<Harness initial={conversation({ status: "OPEN" })} />);
    const options = () =>
      within(screen.getByLabelText("Status"))
        .getAllByRole("option")
        .map((o) => o.textContent);
    expect(options()).toEqual(["Open", "Pending", "Resolved"]);
    unmount();
    renderWithQuery(<Harness initial={conversation({ status: "RESOLVED" })} />);
    expect(options()).toEqual(["Resolved", "Open"]);
  });

  it("shows the new status immediately (before the server answers), then keeps it", async () => {
    const gate = deferred<Response>();
    const api = mockApi({
      "PATCH /api/conversations/c1": () => gate.promise,
      ...refetchRoutes(conversation({ status: "RESOLVED" })),
    });
    const user = userEvent.setup();
    renderWithQuery(<Harness initial={conversation()} />);

    await user.selectOptions(screen.getByLabelText("Status"), "RESOLVED");
    await waitFor(() => expect(screen.getByLabelText("Status")).toHaveValue("RESOLVED"));
    expect(api.calls[0].body).toEqual({ status: "RESOLVED" });

    gate.resolve(json(200, { conversation: conversation({ status: "RESOLVED" }) }));
    await waitFor(() => expect(screen.getByLabelText("Status")).toHaveValue("RESOLVED"));
  });

  it("rolls the status back and shows the server's reason when the change is refused", async () => {
    mockApi({
      "PATCH /api/conversations/c1": () =>
        apiError(409, "conflict", "Cannot change status from RESOLVED to PENDING"),
      ...refetchRoutes(conversation({ status: "OPEN" })),
    });
    const user = userEvent.setup();
    renderWithQuery(<Harness initial={conversation({ status: "OPEN" })} />);
    await user.selectOptions(screen.getByLabelText("Status"), "PENDING");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Cannot change status from RESOLVED to PENDING",
    );
    expect(screen.getByLabelText("Status")).toHaveValue("OPEN");
  });

  it("changes priority optimistically and rolls it back on failure", async () => {
    mockApi({
      "PATCH /api/conversations/c1": () => apiError(500, "internal_error", "Something went wrong"),
      ...refetchRoutes(conversation({ priority: "NORMAL" })),
    });
    const user = userEvent.setup();
    renderWithQuery(<Harness initial={conversation({ priority: "NORMAL" })} />);
    await user.selectOptions(screen.getByLabelText("Priority"), "URGENT");
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByLabelText("Priority")).toHaveValue("NORMAL");
  });

  it("lets a member claim an unassigned conversation: the button flips at once", async () => {
    const gate = deferred<Response>();
    const api = mockApi({
      "POST /api/conversations/c1/assign": () => gate.promise,
      ...refetchRoutes(
        conversation({ assignee: { id: "me", name: "Me", email: "me@example.com" } }),
      ),
    });
    const user = userEvent.setup();
    renderWithQuery(<Harness initial={conversation()} />);
    expect(screen.queryByLabelText("Assignee")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Assign to me" }));
    expect(await screen.findByRole("button", { name: "Unassign me" })).toBeInTheDocument();
    expect(api.calls[0].body).toEqual({ userId: "me" });
    gate.resolve(
      json(200, {
        conversation: conversation({ assignee: { id: "me", name: "Me", email: "me@example.com" } }),
      }),
    );
  });

  it("restores the previous assignee when assignment fails", async () => {
    mockApi({
      "POST /api/conversations/c1/assign": () =>
        apiError(403, "forbidden", "You do not have permission to perform this action"),
      ...refetchRoutes(conversation()),
    });
    const user = userEvent.setup();
    renderWithQuery(<Harness initial={conversation()} />);
    await user.click(screen.getByRole("button", { name: "Assign to me" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("do not have permission");
    expect(screen.getByRole("button", { name: "Assign to me" })).toBeInTheDocument();
  });

  it("shows read-only text when someone else holds the conversation (member view)", () => {
    mockApi({});
    renderWithQuery(
      <Harness
        initial={conversation({
          assignee: { id: "other", name: "Other", email: "other@example.com" },
        })}
      />,
    );
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /assign|unassign/i })).not.toBeInTheDocument();
  });

  it("gives admins a full assignee picker including unassign", async () => {
    const api = mockApi({
      "POST /api/conversations/c1/assign": () =>
        json(200, {
          conversation: conversation({
            assignee: { id: "other", name: "Other", email: "other@example.com" },
          }),
        }),
      "POST /api/conversations/c1/unassign": () => json(200, { conversation: conversation() }),
      ...refetchRoutes(conversation()),
    });
    const user = userEvent.setup();
    renderWithQuery(
      <Harness
        initial={conversation({ assignee: { id: "me", name: "Me", email: "me@example.com" } })}
        canAssignOthers
      />,
    );
    const select = screen.getByLabelText("Assignee");
    await user.selectOptions(select, "other");
    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/assign")).toBe(1));
    expect(api.calls.find((c) => c.url.endsWith("/assign"))!.body).toEqual({ userId: "other" });
    await user.selectOptions(select, "");
    await waitFor(() => expect(api.count("POST", "/api/conversations/c1/unassign")).toBe(1));
  });

  it("disables status and priority without permission", () => {
    mockApi({});
    renderWithQuery(<Harness initial={conversation()} canUpdate={false} />);
    expect(screen.getByLabelText("Status")).toBeDisabled();
    expect(screen.getByLabelText("Priority")).toBeDisabled();
  });
});
