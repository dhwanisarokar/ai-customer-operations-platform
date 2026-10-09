// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, json, mockApi, renderWithQuery } from "../../../../tests/helpers/query";
import { HandlingModeControl } from "./handling-mode-control";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Overrides = Partial<{ channel: string; handlingMode: "AI" | "HUMAN" }>;
const plain = (overrides: Overrides = {}) => ({
  id: "c1",
  channel: "WEB_CHAT",
  handlingMode: "AI" as const,
  ...overrides,
});
const conv = (overrides: Overrides = {}) => plain(overrides) as never;

describe("HandlingModeControl", () => {
  it("shows the mode and switches to human with one click (stops the AI immediately)", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "POST /api/conversations/c1/handling": () =>
        json(200, { conversation: plain({ handlingMode: "HUMAN" }) }),
    });
    renderWithQuery(<HandlingModeControl conversation={conv()} canChange />);
    expect(screen.getByText("AI handling")).toBeTruthy();
    expect(screen.getByText(/may answer new visitor messages/i)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Switch to human" }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]).toMatchObject({
      method: "POST",
      url: "/api/conversations/c1/handling",
      body: { mode: "HUMAN" },
    });
  });

  it("asks for confirmation before enabling AI, and Cancel sends nothing", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "POST /api/conversations/c1/handling": () =>
        json(200, { conversation: plain({ handlingMode: "AI" }) }),
    });
    renderWithQuery(
      <HandlingModeControl conversation={conv({ handlingMode: "HUMAN" })} canChange />,
    );
    expect(screen.getByText("Human handling")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Switch to AI…" }));
    expect(screen.getByText(/next messages may be answered automatically/i)).toBeTruthy();
    expect(screen.getByText(/Nothing is sent when you switch/i)).toBeTruthy();
    expect(api.calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Confirm AI handling" })).toBeNull();
    expect(api.calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Switch to AI…" }));
    await user.click(screen.getByRole("button", { name: "Switch to AI" }));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0].body).toEqual({ mode: "AI" });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Confirm AI handling" })).toBeNull(),
    );
  });

  it("shows the server's reason when enabling AI is refused, and keeps the confirmation open", async () => {
    const user = userEvent.setup();
    mockApi({
      "POST /api/conversations/c1/handling": () =>
        apiError(409, "conflict", "Customer-facing AI is not enabled for this organization"),
    });
    renderWithQuery(
      <HandlingModeControl conversation={conv({ handlingMode: "HUMAN" })} canChange />,
    );
    await user.click(screen.getByRole("button", { name: "Switch to AI…" }));
    await user.click(screen.getByRole("button", { name: "Switch to AI" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /not enabled for this organization/,
    );
    expect(screen.getByRole("group", { name: "Confirm AI handling" })).toBeTruthy();
  });

  it("is read-only without permission (label only, no switch buttons)", () => {
    mockApi({});
    renderWithQuery(<HandlingModeControl conversation={conv()} canChange={false} />);
    expect(screen.getByText("AI handling")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("is not shown for conversations that are not web chat", () => {
    mockApi({});
    const { container } = renderWithQuery(
      <HandlingModeControl conversation={conv({ channel: "IN_APP" })} canChange />,
    );
    expect(container.textContent).toBe("");
  });
});
