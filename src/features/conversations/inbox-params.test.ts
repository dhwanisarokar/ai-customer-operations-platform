import { describe, expect, it } from "vitest";
import { describeEvent } from "./event-text";
import { inboxHref, parseInboxParams } from "./inbox-params";

describe("parseInboxParams", () => {
  it("defaults to the Open view", () => {
    const { view, query } = parseInboxParams({});
    expect(view).toBe("open");
    expect(query).toMatchObject({ status: ["OPEN"], sort: "lastMessageAt", order: "desc" });
  });

  it.each([
    ["mine", { assignee: "me", status: ["OPEN", "PENDING"] }],
    ["unassigned", { assignee: "unassigned" }],
    ["urgent", { priority: ["URGENT"] }],
    ["high", { priority: ["HIGH", "URGENT"] }],
    ["resolved", { status: ["RESOLVED"] }],
  ])("maps the %s view to server-side filters", (view, expected) => {
    expect(parseInboxParams({ view }).query).toMatchObject(expected);
  });

  it("the all view has no status filter", () => {
    expect(parseInboxParams({ view: "all" }).query.status).toBeUndefined();
  });

  it("carries search, page, selection and customer filter, ignoring junk", () => {
    const customerId = crypto.randomUUID();
    const selected = crypto.randomUUID();
    const parsed = parseInboxParams({
      view: "all",
      q: "refund",
      page: "2",
      c: selected,
      customer: customerId,
    });
    expect(parsed).toMatchObject({ q: "refund", page: 2, selectedId: selected, customerId });
    expect(parsed.query.customerId).toBe(customerId);

    const junk = parseInboxParams({ view: "bogus", page: "-1", c: "nope", customer: "nope" });
    expect(junk).toMatchObject({ view: "open", page: 1, selectedId: null, customerId: null });
  });
});

describe("inboxHref", () => {
  it("omits defaults and keeps what matters", () => {
    expect(inboxHref({}, {})).toBe("/dashboard/inbox");
    expect(inboxHref({ view: "mine", q: "x" }, { c: "abc" })).toBe(
      "/dashboard/inbox?view=mine&q=x&c=abc",
    );
    expect(inboxHref({ view: "open", page: 3, c: "abc" }, { c: null })).toBe(
      "/dashboard/inbox?page=3",
    );
  });
});

describe("describeEvent", () => {
  const names = new Map([
    ["u1", "Dana"],
    ["u2", "Eli"],
  ]);
  const event = (
    type: string,
    metadata: unknown,
    actorId: string | null = "u1",
    actorType = "USER",
  ) => ({
    type,
    metadata,
    actorId,
    actorType,
  });

  it("words the main audit events", () => {
    expect(describeEvent(event("STATUS_CHANGED", { from: "RESOLVED", to: "OPEN" }), names)).toBe(
      "Dana changed the status from Resolved to Open",
    );
    expect(describeEvent(event("PRIORITY_CHANGED", { from: "NORMAL", to: "URGENT" }), names)).toBe(
      "Dana changed the priority from Normal to Urgent",
    );
    expect(describeEvent(event("ASSIGNED", { from: "u1", to: "u2" }), names)).toBe(
      "Dana reassigned the conversation from Dana to Eli",
    );
    expect(describeEvent(event("UNASSIGNED", { from: "u2" }), names)).toBe(
      "Dana unassigned the conversation from Eli",
    );
  });

  it("explains customer-triggered reopen and member removal", () => {
    expect(
      describeEvent(
        event("STATUS_CHANGED", { from: "RESOLVED", to: "OPEN", reason: "customer_message" }),
        names,
      ),
    ).toContain("(customer replied)");
    expect(
      describeEvent(event("UNASSIGNED", { from: "gone", reason: "member_removed" }), names),
    ).toBe("Unassigned from a former member (left the organization)");
  });

  it("degrades gracefully for unknown actors and system events", () => {
    expect(describeEvent(event("CONVERSATION_CREATED", {}, "unknown"), names)).toBe(
      "A team member created the conversation",
    );
    expect(describeEvent(event("CONVERSATION_CREATED", {}, null, "SYSTEM"), names)).toBe(
      "System created the conversation",
    );
  });
});
