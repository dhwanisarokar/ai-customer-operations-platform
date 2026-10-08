// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { json, mockApi, renderWithQuery } from "../../../../tests/helpers/query";
import type { AutomationJson, ExecutionDetailJson } from "../api/types";
import { AutomationForm } from "./automation-form";
import { AutomationListView } from "./automation-list-view";
import { ExecutionDetailView } from "./execution-detail-view";
import { ExecutionHistory } from "./execution-history";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  push.mockClear();
  vi.unstubAllGlobals();
});

const members = [
  { id: "11111111-1111-4111-8111-111111111111", label: "Dana" },
  { id: "22222222-2222-4222-8222-222222222222", label: "Eli" },
];

const automation = (overrides: Partial<AutomationJson> = {}): AutomationJson => ({
  id: "a1",
  name: "Urgent routing",
  description: null,
  enabled: true,
  trigger: "conversation.priority_changed",
  conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
  actions: [{ type: "add_customer_tag", input: { tag: "urgent" } }],
  createdByUserId: "u1",
  createdAt: "2026-01-01T10:00:00.000Z",
  updatedAt: "2026-01-01T10:00:00.000Z",
  ...overrides,
});

const run = (overrides: Partial<ExecutionDetailJson> = {}): ExecutionDetailJson => ({
  id: "r1",
  automationId: "a1",
  eventId: "e1",
  eventType: "conversation.priority_changed",
  status: "COMPLETED",
  attempts: 1,
  createdAt: "2026-01-01T10:00:00.000Z",
  startedAt: "2026-01-01T10:00:01.000Z",
  completedAt: "2026-01-01T10:00:02.000Z",
  errorCode: null,
  errorMessage: null,
  memberNames: {},
  eventData: { conversationId: "c1", priority: "URGENT", previousPriority: "NORMAL" },
  definition: {
    name: "Urgent routing",
    trigger: "conversation.priority_changed",
    conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
    actions: [
      { type: "add_customer_tag", input: { tag: "urgent" } },
      { type: "assign_conversation", input: { assigneeId: "u9" } },
    ],
  },
  conditionResults: [
    { field: "priority", operator: "equals", expected: "URGENT", actual: "URGENT", passed: true },
  ],
  actionResults: [
    { index: 0, action: "add_customer_tag", status: "completed" },
    { index: 1, action: "assign_conversation", status: "completed" },
  ],
  ...overrides,
});

const page = <T,>(items: T[]) => ({
  items,
  page: 1,
  pageSize: 50,
  total: items.length,
  totalPages: 1,
});

describe("AutomationForm (builder)", () => {
  it("builds WHEN / AND / THEN and posts exactly what the registries support", async () => {
    const api = mockApi({
      "POST /api/automations": () => json(201, { automation: automation({ id: "new1" }) }),
      "GET /api/automations": () => json(200, page([])),
    });
    const user = userEvent.setup();
    renderWithQuery(<AutomationForm mode="create" members={members} canEdit />);

    await user.type(screen.getByLabelText("Name"), "Urgent routing");
    // Default trigger is "Conversation priority changed".
    await user.click(screen.getByRole("button", { name: /Add condition/ }));
    await user.selectOptions(screen.getByLabelText("Condition 1 field"), "priority");
    await user.selectOptions(screen.getByLabelText("Condition 1 value"), "URGENT");

    // The default first action is "Add tag to customer".
    await user.type(screen.getByLabelText("Action 1 tag name"), "urgent");
    await user.click(screen.getByRole("button", { name: /Add action/ }));
    await user.selectOptions(screen.getByLabelText("Action 2 type"), "assign_conversation");
    await user.selectOptions(screen.getByLabelText("Action 2 assignee"), members[1].id);

    await user.click(screen.getByRole("button", { name: "Create automation" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/automations/new1"));
    expect(api.calls.find((c) => c.method === "POST")!.body).toEqual({
      name: "Urgent routing",
      description: null,
      enabled: true,
      trigger: "conversation.priority_changed",
      conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
      actions: [
        { type: "add_customer_tag", input: { tag: "urgent" } },
        { type: "assign_conversation", input: { assigneeId: members[1].id } },
      ],
    });
  });

  it("only offers operators that fit the field and drops the value box for 'exists'", async () => {
    mockApi({});
    const user = userEvent.setup();
    renderWithQuery(<AutomationForm mode="create" members={members} canEdit />);
    await user.click(screen.getByRole("button", { name: /Add condition/ }));
    const operators = within(screen.getByLabelText("Condition 1 operator"))
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(operators).toEqual(["equals", "does not equal", "exists"]); // enum field: no contains/greater_than
    await user.selectOptions(screen.getByLabelText("Condition 1 operator"), "exists");
    expect(screen.queryByLabelText("Condition 1 value")).not.toBeInTheDocument();
  });

  it("changing the trigger removes conditions and actions that no longer apply", async () => {
    mockApi({});
    const user = userEvent.setup();
    renderWithQuery(
      <AutomationForm
        mode="edit"
        automation={automation({
          actions: [
            { type: "assign_conversation", input: { assigneeId: members[0].id } },
            { type: "add_customer_tag", input: { tag: "x" } },
          ],
        })}
        members={members}
        canEdit
      />,
    );
    expect(screen.getByLabelText("Condition 1 field")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Trigger"), "customer.created");
    // "priority" is not a customer.created field, and assigning a conversation has no conversation.
    expect(screen.queryByLabelText("Condition 1 field")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Action 2 type")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Action 1 type")).toHaveValue("add_customer_tag");
  });

  it("shows every validation problem the server reports", async () => {
    mockApi({
      "POST /api/automations": () =>
        json(400, {
          error: {
            code: "validation_error",
            message: "The automation is not valid",
            details: {
              problems: [
                "Condition 1: a value is required.",
                "Action 1: tag: Tag name is required",
              ],
            },
          },
        }),
    });
    const user = userEvent.setup();
    renderWithQuery(<AutomationForm mode="create" members={members} canEdit />);
    await user.type(screen.getByLabelText("Name"), "x");
    await user.click(screen.getByRole("button", { name: "Create automation" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The automation is not valid");
    expect(alert).toHaveTextContent("Condition 1: a value is required.");
    expect(alert).toHaveTextContent("Action 1: tag: Tag name is required");
    expect(push).not.toHaveBeenCalled();
  });

  it("is read-only without permission (the API enforces it anyway)", () => {
    mockApi({});
    renderWithQuery(
      <AutomationForm mode="edit" automation={automation()} members={members} canEdit={false} />,
    );
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
  });

  it("saves changes to an existing automation and confirms deletion in two steps", async () => {
    const api = mockApi({
      "PATCH /api/automations/a1": () => json(200, { automation: automation({ name: "Renamed" }) }),
      "DELETE /api/automations/a1": () => new Response(null, { status: 204 }),
      "GET /api/automations": () => json(200, page([])),
    });
    const user = userEvent.setup();
    renderWithQuery(
      <AutomationForm mode="edit" automation={automation()} members={members} canEdit canDelete />,
    );
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Renamed");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(api.calls.find((c) => c.method === "PATCH")!.body).toMatchObject({ name: "Renamed" });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(api.count("DELETE", "/api/automations/a1")).toBe(0); // needs confirmation
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard/automations"));
  });
});

describe("AutomationListView", () => {
  it("lists automations and disables one through the API", async () => {
    const api = mockApi({
      "POST /api/automations/a1/disable": () =>
        json(200, { automation: automation({ enabled: false }) }),
      "GET /api/automations": () => json(200, page([automation({ enabled: false })])),
    });
    const user = userEvent.setup();
    renderWithQuery(<AutomationListView initialData={page([automation()])} canCreate canUpdate />);
    expect(screen.getByRole("link", { name: "Urgent routing" })).toHaveAttribute(
      "href",
      "/dashboard/automations/a1",
    );
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Disable Urgent routing" }));
    await waitFor(() => expect(api.count("POST", "/api/automations/a1/disable")).toBe(1));
    expect(await screen.findByText("Disabled")).toBeInTheDocument();
  });

  it("hides the enable/disable control without permission and explains the empty state", () => {
    mockApi({});
    const { unmount } = renderWithQuery(
      <AutomationListView initialData={page([automation()])} canCreate={false} canUpdate={false} />,
    );
    expect(screen.queryByRole("button", { name: /Disable/ })).not.toBeInTheDocument();
    unmount();
    renderWithQuery(<AutomationListView initialData={page([])} canCreate canUpdate />);
    expect(screen.getByText("No automations yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New automation" })).toBeInTheDocument();
  });
});

describe("execution history and details", () => {
  it("lists runs with status, attempts and the failure reason", () => {
    mockApi({});
    renderWithQuery(
      <ExecutionHistory
        automationId="a1"
        initialData={page([
          run(),
          run({
            id: "r2",
            status: "FAILED",
            attempts: 3,
            errorCode: "NOT_FOUND",
            errorMessage: "Member not found",
          }),
        ])}
      />,
    );
    expect(screen.getByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText(/3 attempts/)).toBeInTheDocument();
    expect(screen.getByText("Member not found")).toBeInTheDocument();
    expect(screen.getAllByRole("link")[0]).toHaveAttribute(
      "href",
      "/dashboard/automations/a1/executions/r1",
    );
  });

  it("explains a run: trigger event, each condition and each action", () => {
    mockApi({});
    renderWithQuery(
      <ExecutionDetailView automationId="a1" executionId="r1" initialData={{ execution: run() }} />,
    );
    expect(screen.getByRole("region", { name: "Trigger" })).toHaveTextContent(
      "Conversation priority changed",
    );
    expect(screen.getByRole("region", { name: "Trigger" })).toHaveTextContent("URGENT");
    const conditions = screen.getByRole("region", { name: "Conditions" });
    expect(within(conditions).getByRole("img", { name: "Passed" })).toBeInTheDocument();
    expect(conditions).toHaveTextContent("New priority equals “URGENT”");
    const actions = screen.getByRole("region", { name: "Actions" });
    expect(actions).toHaveTextContent("Add tag to customer: urgent");
    expect(actions).toHaveTextContent("Assign conversation");
    expect(within(actions).getAllByRole("img", { name: "Passed" })).toHaveLength(2);
  });

  it("shows a failed action with an actionable error, and actions that never ran", () => {
    mockApi({});
    renderWithQuery(
      <ExecutionDetailView
        automationId="a1"
        executionId="r1"
        initialData={{
          execution: run({
            status: "FAILED",
            errorCode: "NOT_FOUND",
            errorMessage: "Member not found",
            actionResults: [
              { index: 0, action: "add_customer_tag", status: "completed" },
              {
                index: 1,
                action: "assign_conversation",
                status: "failed",
                error: { code: "NOT_FOUND", message: "Member not found" },
              },
            ],
            conditionResults: [
              {
                field: "priority",
                operator: "equals",
                expected: "URGENT",
                actual: "HIGH",
                passed: false,
              },
            ],
          }),
        }}
      />,
    );
    expect(screen.getAllByRole("alert")[0]).toHaveTextContent("Member not found");
    const actions = screen.getByRole("region", { name: "Actions" });
    expect(within(actions).getByRole("img", { name: "Failed" })).toBeInTheDocument();
    expect(actions).toHaveTextContent("Member not found (NOT_FOUND)");
    expect(screen.getByRole("region", { name: "Conditions" })).toHaveTextContent("(was NORMAL)");
    // The evaluated value (HIGH here) is not mislabelled as the previous one.
    expect(screen.getByRole("region", { name: "Conditions" })).not.toHaveTextContent("(was HIGH)");
  });
});

describe("execution details: previous values and member names", () => {
  const MEMBER = "4a70a239-8980-4831-8427-c7f6b762abbf";
  const render = (execution: ExecutionDetailJson) =>
    renderWithQuery(
      <ExecutionDetailView automationId="a1" executionId="r1" initialData={{ execution }} />,
    );
  const conditionsText = () => screen.getByRole("region", { name: "Conditions" }).textContent;

  it.each(["NORMAL", "HIGH", "LOW"])(
    "shows the event's real previous priority (%s -> URGENT)",
    (previous) => {
      mockApi({});
      render(
        run({
          eventData: { conversationId: "c1", priority: "URGENT", previousPriority: previous },
        }),
      );
      expect(conditionsText()).toContain(`New priority equals “URGENT” (was ${previous})`);
      expect(conditionsText()).not.toContain("(was URGENT)");
    },
  );

  it("falls back to the evaluated value for fields that have no 'before' counterpart", () => {
    mockApi({});
    render(
      run({
        eventData: { priority: "URGENT", previousPriority: "NORMAL", status: "OPEN" },
        conditionResults: [
          { field: "status", operator: "equals", expected: "OPEN", actual: "OPEN", passed: true },
        ],
      }),
    );
    expect(conditionsText()).toContain("Status equals “OPEN” (value: OPEN)");
    expect(conditionsText()).not.toContain("(was");
  });

  it("shows member names instead of ids in the trigger, conditions and actions", () => {
    mockApi({});
    render(
      run({
        memberNames: { [MEMBER]: "Dhwani Sarokar" },
        eventData: {
          conversationId: "c1",
          priority: "URGENT",
          previousPriority: "NORMAL",
          assignee: MEMBER,
        },
        definition: {
          name: "Urgent routing",
          trigger: "conversation.priority_changed",
          conditions: [],
          actions: [
            { type: "assign_conversation", input: { assigneeId: MEMBER } },
            { type: "add_customer_tag", input: { tag: "urgent" } },
          ],
        },
        conditionResults: [
          { field: "assignee", operator: "equals", expected: MEMBER, actual: MEMBER, passed: true },
        ],
        actionResults: [
          { index: 0, action: "assign_conversation", status: "completed" },
          { index: 1, action: "add_customer_tag", status: "completed" },
        ],
      }),
    );
    expect(screen.getByRole("region", { name: "Trigger" })).toHaveTextContent(
      "AssigneeDhwani Sarokar",
    );
    const actions = screen.getByRole("region", { name: "Actions" });
    expect(actions).toHaveTextContent("Assign conversation: Dhwani Sarokar");
    expect(actions).toHaveTextContent("Add tag to customer: urgent");
    expect(conditionsText()).toContain("Assignee equals “Dhwani Sarokar”");
    // The id is never visible text (it is only a tooltip on the trigger value).
    expect(document.body.textContent).not.toContain(MEMBER);
  });

  it("shows 'Former member' for someone who left or was never in this organization", () => {
    mockApi({});
    render(
      run({
        memberNames: {}, // the server found no membership for this id in this organization
        eventData: { priority: "URGENT", previousPriority: "NORMAL", assignee: MEMBER },
        definition: {
          name: "x",
          trigger: "conversation.priority_changed",
          conditions: [],
          actions: [{ type: "assign_conversation", input: { assigneeId: MEMBER } }],
        },
        actionResults: [{ index: 0, action: "assign_conversation", status: "completed" }],
      }),
    );
    expect(screen.getByRole("region", { name: "Actions" })).toHaveTextContent(
      "Assign conversation: Former member",
    );
    expect(screen.getByRole("region", { name: "Trigger" })).toHaveTextContent("Former member");
    expect(document.body.textContent).not.toContain(MEMBER);
  });

  it("shows 'Unassigned' for an empty assignee (nothing to resolve)", () => {
    mockApi({});
    render(run({ eventData: { priority: "URGENT", previousPriority: "NORMAL", assignee: null } }));
    expect(screen.getByRole("region", { name: "Trigger" })).toHaveTextContent("AssigneeUnassigned");
  });
});
