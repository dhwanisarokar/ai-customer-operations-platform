// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ConversationTimeline } from "./conversation-timeline";

afterEach(cleanup);

const base = {
  messageType: "MESSAGE",
  createdAt: new Date(),
  sender: null,
};

describe("ConversationTimeline: AI messages", () => {
  it("labels AI replies as 'AI Agent' (never as a human) and lists the cited sources", () => {
    render(
      <ConversationTimeline
        names={new Map()}
        events={[]}
        messages={[
          {
            ...base,
            id: "1",
            senderType: "AI_AGENT",
            body: "Refunds are available within 30 days.",
            ai: {
              grounded: true,
              sources: [
                { documentId: "d1", documentTitle: "Refund policy", chunkId: "c1", chunkIndex: 0 },
                { documentId: "d1", documentTitle: "Refund policy", chunkId: "c2", chunkIndex: 1 },
                { documentId: "d2", documentTitle: "Billing FAQ", chunkId: "c3", chunkIndex: 0 },
              ],
            },
          },
        ]}
      />,
    );
    const bubble = screen.getByRole("article", { name: "AI message" });
    expect(bubble).toHaveTextContent("AI Agent");
    expect(bubble).toHaveTextContent("Based on: Refund policy, Billing FAQ");
    expect(screen.queryByRole("article", { name: "Agent message" })).not.toBeInTheDocument();
  });

  it("does not fake citations: ungrounded or source-less replies are flagged instead", () => {
    render(
      <ConversationTimeline
        names={new Map()}
        events={[]}
        messages={[
          {
            ...base,
            id: "1",
            senderType: "AI_AGENT",
            body: "I am not sure.",
            ai: { grounded: false, sources: [] },
          },
          { ...base, id: "2", senderType: "AI_AGENT", body: "Legacy.", ai: null },
        ]}
      />,
    );
    const bubbles = screen.getAllByRole("article", { name: "AI message" });
    expect(bubbles).toHaveLength(2);
    for (const bubble of bubbles) {
      expect(bubble).toHaveTextContent("Not based on your knowledge base");
      expect(bubble).not.toHaveTextContent("Based on:");
    }
  });

  it("shows no source line at all for small talk, but still disclaims out-of-scope replies", () => {
    render(
      <ConversationTimeline
        names={new Map()}
        events={[]}
        messages={[
          {
            ...base,
            id: "1",
            senderType: "AI_AGENT",
            body: "Hello! How can I help you today?",
            ai: { grounded: false, intent: "CONVERSATIONAL", sources: [] },
          },
          {
            ...base,
            id: "2",
            senderType: "AI_AGENT",
            body: "I'm here to help with questions about your account and our services.",
            ai: { grounded: false, intent: "OUT_OF_SCOPE", sources: [] },
          },
        ]}
      />,
    );
    const [greeting, offTopic] = screen.getAllByRole("article", { name: "AI message" });
    expect(greeting).not.toHaveTextContent("Based on:");
    expect(greeting).not.toHaveTextContent("Not based on your knowledge base");
    expect(offTopic).toHaveTextContent("Not based on your knowledge base");
  });
});
