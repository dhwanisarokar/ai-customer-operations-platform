// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageComposer } from "./message-composer";

afterEach(cleanup);

describe("MessageComposer", () => {
  it("hands a customer-facing reply to the outbox and clears the box immediately", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved={false} onSend={onSend} />);
    await user.type(screen.getByRole("textbox"), "Hello there");
    await user.click(screen.getByRole("button", { name: "Send reply" }));

    expect(onSend).toHaveBeenCalledWith({ body: "Hello there", type: "MESSAGE", from: "USER" });
    expect(screen.getByRole("textbox")).toHaveValue("");
  });

  it("switches to an internal note with its own placeholder, button and payload", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved={false} onSend={onSend} />);
    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByRole("radio", { name: "Internal note" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByPlaceholderText(/customer will not see it/i)).toBeInTheDocument();

    await user.type(screen.getByRole("textbox"), "Escalate to billing");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onSend).toHaveBeenCalledWith({
      body: "Escalate to billing",
      type: "INTERNAL_NOTE",
      from: "USER",
    });
  });

  it("can log a message written by the customer", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved={false} onSend={onSend} />);
    await user.click(screen.getByRole("radio", { name: "Log customer message" }));
    await user.type(screen.getByRole("textbox"), "They called");
    await user.click(screen.getByRole("button", { name: "Log message" }));
    expect(onSend).toHaveBeenCalledWith({ body: "They called", type: "MESSAGE", from: "CUSTOMER" });
  });

  it("submits with Ctrl+Enter", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved={false} onSend={onSend} />);
    await user.type(screen.getByRole("textbox"), "Quick{Control>}{Enter}{/Control}");
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend.mock.calls[0][0].body).toBe("Quick");
  });

  it("rejects empty input without sending", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved={false} onSend={onSend} />);
    await user.click(screen.getByRole("button", { name: "Send reply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message cannot be empty");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("blocks agent replies on resolved conversations but still allows internal notes", async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageComposer resolved onSend={onSend} />);
    expect(screen.getByRole("textbox")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send reply" })).toBeDisabled();
    expect(screen.getByText(/Reopen it to reply/i)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Internal note" }));
    expect(screen.getByRole("textbox")).toBeEnabled();
    await user.type(screen.getByRole("textbox"), "note");
    await user.click(screen.getByRole("button", { name: "Add note" }));
    expect(onSend).toHaveBeenCalledWith({ body: "note", type: "INTERNAL_NOTE", from: "USER" });
  });
});

describe("MessageComposer: AI suggestion basis", () => {
  const suggestion = (overrides: Record<string, unknown>) => ({
    draft: "Your name is Alice.",
    grounded: false,
    accountData: false,
    intent: "SUPPORT",
    sources: [],
    approvals: [],
    ...overrides,
  });

  it("says the suggestion is based on the customer record when it came from account data", () => {
    render(
      <MessageComposer
        resolved={false}
        onSend={vi.fn()}
        suggestion={suggestion({ accountData: true })}
      />,
    );
    expect(screen.getByRole("status", { name: "AI suggested reply" })).toHaveTextContent(
      "Based on: customer record",
    );
    expect(screen.queryByText(/Not based on your knowledge base/)).not.toBeInTheDocument();
  });

  it("still warns when it is based on neither knowledge nor the customer record", () => {
    render(<MessageComposer resolved={false} onSend={vi.fn()} suggestion={suggestion({})} />);
    expect(screen.getByRole("status", { name: "AI suggested reply" })).toHaveTextContent(
      "Not based on your knowledge base",
    );
  });
});
