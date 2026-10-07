// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivityTimeline } from "./activity-timeline";

const at = (daysAgo: number, hour: number) => {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, 0, 0, 0);
  return date;
};

describe("ActivityTimeline", () => {
  it("shows an empty message when there is no activity", () => {
    render(<ActivityTimeline activities={[]} emptyLabel="Nothing here" />);
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("groups entries by day, preserving the given (newest-first) order", () => {
    render(
      <ActivityTimeline
        activities={[
          {
            id: "1",
            type: "NOTE_ADDED",
            title: "Note added",
            description: "Called back",
            createdAt: at(0, 11),
          },
          {
            id: "2",
            type: "TAG_ADDED",
            title: 'Tag "VIP" added',
            description: null,
            createdAt: at(0, 9),
          },
          {
            id: "3",
            type: "CUSTOMER_CREATED",
            title: "Customer created",
            description: null,
            createdAt: at(1, 10),
          },
        ]}
      />,
    );

    const today = screen.getByRole("region", { name: "Today" });
    const yesterday = screen.getByRole("region", { name: "Yesterday" });
    const todayItems = within(today).getAllByRole("listitem");
    expect(todayItems).toHaveLength(2);
    expect(todayItems[0]).toHaveTextContent("Note added");
    expect(todayItems[0]).toHaveTextContent("Called back");
    expect(todayItems[1]).toHaveTextContent('Tag "VIP" added');
    expect(within(yesterday).getByText("Customer created")).toBeInTheDocument();
  });

  it("renders activity types it does not know about", () => {
    render(
      <ActivityTimeline
        activities={[
          {
            id: "9",
            type: "CONVERSATION_STARTED",
            title: "Conversation started",
            description: null,
            createdAt: at(0, 8),
          },
        ]}
      />,
    );
    expect(screen.getByText("Conversation started")).toBeInTheDocument();
  });
});
