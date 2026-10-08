import { describe, expect, it } from "vitest";
import {
  conditionsSchema,
  evaluateConditions,
  sanitizeEventData,
  validateConditions,
  type Condition,
} from "./conditions";

const run = (conditions: Condition[], data: Record<string, unknown>) =>
  evaluateConditions("conversation.priority_changed", conditions, data);

describe("condition operators", () => {
  const data = { priority: "URGENT", status: "OPEN", assignee: null, customerId: "c1" };

  it("equals / not_equals compare case-insensitively and treat missing as not equal", () => {
    expect(run([{ field: "priority", operator: "equals", value: "urgent" }], data).passed).toBe(
      true,
    );
    expect(run([{ field: "priority", operator: "equals", value: "HIGH" }], data).passed).toBe(
      false,
    );
    expect(run([{ field: "priority", operator: "not_equals", value: "HIGH" }], data).passed).toBe(
      true,
    );
    expect(run([{ field: "assignee", operator: "equals", value: "x" }], data).passed).toBe(false);
    expect(run([{ field: "assignee", operator: "not_equals", value: "x" }], data).passed).toBe(
      true,
    );
  });

  it("exists is true only for present, non-empty values", () => {
    expect(run([{ field: "priority", operator: "exists" }], data).passed).toBe(true);
    expect(run([{ field: "assignee", operator: "exists" }], data).passed).toBe(false);
    expect(run([{ field: "assignee", operator: "exists" }], { assignee: "" }).passed).toBe(false);
    expect(run([{ field: "assignee", operator: "exists" }], { assignee: "u1" }).passed).toBe(true);
  });

  it("contains / not_contains work on text and on lists", () => {
    const customerEvent = (conditions: Condition[], d: Record<string, unknown>) =>
      evaluateConditions("customer.updated", conditions, d);
    const d = { company: "Acme Corp", changedFields: ["email", "company"] };
    expect(
      customerEvent([{ field: "company", operator: "contains", value: "acme" }], d).passed,
    ).toBe(true);
    expect(
      customerEvent([{ field: "company", operator: "not_contains", value: "xyz" }], d).passed,
    ).toBe(true);
    expect(
      customerEvent([{ field: "changedFields", operator: "contains", value: "email" }], d).passed,
    ).toBe(true);
    expect(
      customerEvent([{ field: "changedFields", operator: "contains", value: "phone" }], d).passed,
    ).toBe(false);
    expect(
      customerEvent([{ field: "changedFields", operator: "not_contains", value: "phone" }], d)
        .passed,
    ).toBe(true);
    expect(
      customerEvent([{ field: "company", operator: "contains", value: "acme" }], {}).passed,
    ).toBe(false);
  });

  it("greater_than / less_than only apply to numbers (no current field is numeric)", () => {
    // Defense in depth: even if a definition slipped through, a non-number never satisfies them.
    expect(run([{ field: "priority", operator: "greater_than", value: 1 }], data).passed).toBe(
      false,
    );
    expect(run([{ field: "priority", operator: "less_than", value: 1 }], data).passed).toBe(false);
  });

  it("ANDs conditions, reports every result, and an empty list always matches", () => {
    const out = run(
      [
        { field: "priority", operator: "equals", value: "URGENT" },
        { field: "status", operator: "equals", value: "RESOLVED" },
      ],
      data,
    );
    expect(out.passed).toBe(false);
    expect(out.results.map((r) => r.passed)).toEqual([true, false]);
    expect(out.results[0]).toMatchObject({
      field: "priority",
      expected: "URGENT",
      actual: "URGENT",
    });
    expect(run([], data)).toEqual({ passed: true, results: [] });
  });

  it("never matches an unsupported field and never records the value of sensitive fields", () => {
    expect(run([{ field: "password", operator: "exists" }], { password: "x" }).passed).toBe(false);
    const message = evaluateConditions(
      "message.created",
      [{ field: "body", operator: "contains", value: "refund" }],
      { body: "I want a refund please" },
    );
    expect(message.passed).toBe(true);
    expect(message.results[0]).not.toHaveProperty("actual");
  });
});

describe("condition validation", () => {
  const validate = (conditions: Condition[]) =>
    validateConditions("conversation.priority_changed", conditions);

  it("accepts conditions that fit the trigger", () => {
    expect(validate([{ field: "priority", operator: "equals", value: "URGENT" }])).toEqual([]);
    expect(validate([{ field: "assignee", operator: "exists" }])).toEqual([]);
  });

  it("rejects unsupported fields, operators, missing values and bad enum values", () => {
    expect(validate([{ field: "nope", operator: "equals", value: "x" }])[0]).toMatch(
      /not available/,
    );
    expect(validate([{ field: "priority", operator: "contains", value: "U" }])[0]).toMatch(
      /cannot be used/,
    );
    expect(validate([{ field: "priority", operator: "greater_than", value: 1 }])[0]).toMatch(
      /cannot be used/,
    );
    expect(validate([{ field: "priority", operator: "equals" }])[0]).toMatch(/value is required/);
    expect(validate([{ field: "priority", operator: "equals", value: "SUPER" }])[0]).toMatch(
      /not a valid/,
    );
    expect(validate([{ field: "priority", operator: "equals", value: 5 }])[0]).toMatch(
      /needs text/,
    );
  });

  it("the Zod schema is strict and bounded", () => {
    expect(conditionsSchema.safeParse([{ field: "a", operator: "equals", extra: 1 }]).success).toBe(
      false,
    );
    expect(conditionsSchema.safeParse([{ field: "a", operator: "matches_regex" }]).success).toBe(
      false,
    );
    expect(
      conditionsSchema.safeParse(Array(11).fill({ field: "a", operator: "exists" })).success,
    ).toBe(false);
  });
});

describe("sanitizeEventData", () => {
  it("drops sensitive and unknown fields", () => {
    expect(
      sanitizeEventData("message.created", {
        messageId: "m1",
        body: "secret text",
        senderType: "CUSTOMER",
        stray: "x",
      }),
    ).toEqual({ messageId: "m1", senderType: "CUSTOMER" });
  });
});
