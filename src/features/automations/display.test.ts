import { describe, expect, it } from "vitest";
import { TRIGGER_CATALOG } from "@/server/automation/catalog";
import { collectMemberIds } from "@/server/automation/references";
import { conditionNote, displayValue, memberLabel } from "./display";

const ID = "4a70a239-8980-4831-8427-c7f6b762abbf";

describe("memberLabel / displayValue", () => {
  it("resolves ids to names and degrades gracefully", () => {
    expect(memberLabel(ID, { [ID]: "Dhwani Sarokar" })).toBe("Dhwani Sarokar");
    expect(memberLabel(ID, {})).toBe("Former member");
    expect(memberLabel(null, {})).toBe("Unassigned");
    expect(memberLabel("", {})).toBe("Unassigned");
  });

  it("only member-reference fields are resolved", () => {
    const fields = TRIGGER_CATALOG["conversation.assigned"].fields;
    expect(displayValue(fields.assignee, ID, { [ID]: "Dhwani" })).toBe("Dhwani");
    expect(displayValue(fields.status, "OPEN", { OPEN: "nope" })).toBe("OPEN");
    expect(displayValue(fields.conversationId, ID, { [ID]: "Dhwani" })).toBe(ID); // not a member ref
  });
});

describe("conditionNote", () => {
  const trigger = TRIGGER_CATALOG["conversation.priority_changed"];

  it("reads the previous value from the event, not from the evaluated condition", () => {
    for (const previous of ["NORMAL", "HIGH", "LOW", "URGENT"]) {
      expect(
        conditionNote(
          trigger,
          { field: "priority", actual: "URGENT" },
          { previousPriority: previous },
          {},
        ),
      ).toBe(`was ${previous}`);
    }
  });

  it("uses the evaluated value when a field has no previous counterpart", () => {
    expect(conditionNote(trigger, { field: "status", actual: "OPEN" }, {}, {})).toBe("value: OPEN");
    expect(conditionNote(trigger, { field: "status" }, {}, {})).toBeNull();
  });

  it("supports the other 'changed' triggers generically", () => {
    expect(
      conditionNote(
        TRIGGER_CATALOG["conversation.status_changed"],
        { field: "status", actual: "RESOLVED" },
        { previousStatus: "OPEN" },
        {},
      ),
    ).toBe("was OPEN");
    expect(
      conditionNote(
        TRIGGER_CATALOG["conversation.assigned"],
        { field: "assignee", actual: ID },
        { previousAssignee: ID },
        { [ID]: "Dhwani" },
      ),
    ).toBe("was Dhwani");
    expect(
      conditionNote(
        TRIGGER_CATALOG["conversation.assigned"],
        { field: "assignee", actual: ID },
        { previousAssignee: null },
        {},
      ),
    ).toBe("was Unassigned");
  });
});

describe("collectMemberIds", () => {
  const execution = {
    eventType: "conversation.assigned",
    eventData: { conversationId: "c1", assignee: ID, previousAssignee: "u2", status: "OPEN" },
    definition: {
      actions: [
        { type: "assign_conversation", input: { assigneeId: "u3" } },
        { type: "add_customer_tag", input: { tag: "x" } },
      ],
    },
    conditionResults: [
      { field: "assignee", expected: "u4", actual: ID },
      { field: "status", expected: "OPEN" },
    ],
  };

  it("finds every member reference once, and ignores everything else", () => {
    expect(collectMemberIds(execution).sort()).toEqual([ID, "u2", "u3", "u4"].sort());
  });

  it("ignores unknown event types and non-string values", () => {
    expect(collectMemberIds({ ...execution, eventType: "nope", conditionResults: [] })).toEqual([
      "u3",
    ]);
    expect(
      collectMemberIds({ ...execution, eventData: { assignee: null }, conditionResults: [] }),
    ).toEqual(["u3"]);
  });
});
