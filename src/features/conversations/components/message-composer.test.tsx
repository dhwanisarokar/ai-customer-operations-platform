// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageComposer } from "./message-composer";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

const fetchMock = vi.fn();
beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValue(
    new Response(JSON.stringify({ message: { id: "m1" } }), {
      status: 201,
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

const bodyOfCall = () => JSON.parse(fetchMock.mock.calls[0][1].body);

describe("MessageComposer", () => {
  it("sends a customer-facing reply by default", async () => {
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved={false} />);
    await user.type(screen.getByRole("textbox"), "Hello there");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/c1/messages");
    expect(bodyOfCall()).toEqual({ body: "Hello there", type: "MESSAGE", from: "USER" });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("switches to an internal note with a distinct submit action and payload", async () => {
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved={false} />);
    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByRole("radio", { name: "Internal note" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByPlaceholderText(/customer will not see it/i)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "Escalate to billing");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOfCall()).toEqual({
      body: "Escalate to billing",
      type: "INTERNAL_NOTE",
      from: "USER",
    });
  });

  it("can log a message written by the customer", async () => {
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved={false} />);
    await user.click(screen.getByRole("radio", { name: "Log customer message" }));
    await user.type(screen.getByRole("textbox"), "They called");
    await user.click(screen.getByRole("button", { name: "Log message" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOfCall()).toMatchObject({ type: "MESSAGE", from: "CUSTOMER" });
  });

  it("submits with Ctrl+Enter", async () => {
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved={false} />);
    await user.type(screen.getByRole("textbox"), "Quick{Control>}{Enter}{/Control}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(bodyOfCall().body).toBe("Quick");
  });

  it("rejects empty input without calling the API", async () => {
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved={false} />);
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message cannot be empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks agent replies on resolved conversations but still allows internal notes", async () => {
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(screen.getByText(/Reopen it to reply/i)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByRole("textbox")).toBeEnabled();
  });

  it("shows a safe error and keeps the draft when sending fails", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "internal_error", message: "Something went wrong" } }),
        {
          status: 500,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const user = userEvent.setup();
    render(<MessageComposer conversationId="c1" resolved={false} />);
    await user.type(screen.getByRole("textbox"), "Keep me");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong");
    expect(screen.getByRole("textbox")).toHaveValue("Keep me");
    expect(refresh).not.toHaveBeenCalled();
  });
});
