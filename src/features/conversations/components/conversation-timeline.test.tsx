// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTimeline } from "./conversation-timeline";

afterEach(cleanup);

const at = (hour: number) => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date;
};
const names = new Map([
  ["u1", "Dana"],
  ["u2", "Eli"],
]);
const agent = { id: "u1", name: "Dana", email: "dana@example.com" };

describe("ConversationTimeline", () => {
  it("renders customer messages, agent messages and internal notes as distinct kinds", () => {
    render(
      <ConversationTimeline
        names={names}
        events={[]}
        messages={[
          {
            id: "1",
            senderType: "CUSTOMER",
            messageType: "MESSAGE",
            body: "I need help",
            createdAt: at(9),
            sender: null,
          },
          {
            id: "2",
            senderType: "USER",
            messageType: "MESSAGE",
            body: "On it",
            createdAt: at(10),
            sender: agent,
          },
          {
            id: "3",
            senderType: "USER",
            messageType: "INTERNAL_NOTE",
            body: "Check their invoice",
            createdAt: at(11),
            sender: agent,
          },
        ]}
      />,
    );

    const customer = screen.getByRole("article", { name: "Customer message" });
    const reply = screen.getByRole("article", { name: "Agent message" });
    const note = screen.getByRole("article", { name: "Internal note" });
    expect(customer).toHaveTextContent("I need help");
    expect(reply).toHaveTextContent("Dana");
    expect(note).toHaveTextContent("Check their invoice");
    expect(note).toHaveTextContent("Only visible to your team");
    // The note carries its own styling, different from a normal reply.
    expect(note.className).toContain("border-dashed");
    expect(reply.className).not.toContain("border-dashed");
    expect(within(customer).queryByText("Internal note")).not.toBeInTheDocument();
  });

  it("interleaves audit events chronologically as system lines and skips message events", () => {
    render(
      <ConversationTimeline
        names={names}
        messages={[
          {
            id: "1",
            senderType: "CUSTOMER",
            messageType: "MESSAGE",
            body: "Hi",
            createdAt: at(9),
            sender: null,
          },
          {
            id: "2",
            senderType: "USER",
            messageType: "MESSAGE",
            body: "Hello",
            createdAt: at(12),
            sender: agent,
          },
        ]}
        events={[
          {
            id: "e1",
            type: "STATUS_CHANGED",
            metadata: { from: "OPEN", to: "PENDING" },
            actorType: "USER",
            actorId: "u1",
            createdAt: at(10),
          },
          {
            id: "e2",
            type: "ASSIGNED",
            metadata: { from: null, to: "u2" },
            actorType: "USER",
            actorId: "u1",
            createdAt: at(11),
          },
          {
            id: "e3",
            type: "MESSAGE_SENT",
            metadata: { messageId: "2" },
            actorType: "USER",
            actorId: "u1",
            createdAt: at(12),
          },
        ]}
      />,
    );

    const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
    const order = [
      "Hi",
      "Dana changed the status from Open to Pending",
      "Dana assigned the conversation to Eli",
      "Hello",
    ].map((needle) => items.findIndex((text) => text.includes(needle)));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(items.filter((text) => text.includes("MESSAGE_SENT"))).toHaveLength(0);
  });

  it("shows an empty state when there is nothing yet", () => {
    render(<ConversationTimeline names={names} messages={[]} events={[]} />);
    expect(screen.getByText("No messages yet.")).toBeInTheDocument();
  });
});
