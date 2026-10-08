import { describe, expect, it } from "vitest";
import { actionRegistry, createActionRegistry } from "./actions";
import { ACTION_NAMES, TRIGGER_NAMES } from "./catalog";
import { automationInputSchema, validateDefinition } from "./definition";
import { getTrigger, listTriggers, triggerRegistry } from "./triggers";

describe("trigger registry", () => {
  it("contains every domain event with described, typed condition fields", () => {
    expect([...triggerRegistry.keys()].sort()).toEqual([...TRIGGER_NAMES].sort());
    for (const trigger of listTriggers()) {
      expect(trigger.description.length).toBeGreaterThan(10);
      expect(Object.keys(trigger.fields).length).toBeGreaterThan(0);
      expect(trigger.targets.customer || trigger.targets.conversation).toBe(true);
    }
  });

  it("conversation.priority_changed supports priority, status, assignee and customerId", () => {
    const fields = Object.keys(getTrigger("conversation.priority_changed")!.fields);
    for (const field of ["priority", "status", "assignee", "customerId"]) {
      expect(fields).toContain(field);
    }
  });

  it("unknown triggers do not resolve", () => {
    expect(getTrigger("conversation.deleted")).toBeUndefined();
  });
});

describe("action registry", () => {
  it("contains exactly the initial actions with a permission and a strict schema each", () => {
    expect([...actionRegistry.keys()].sort()).toEqual([...ACTION_NAMES].sort());
    for (const action of actionRegistry.values()) {
      expect(action.requiredPermission).toBeTruthy();
      expect(action.execute).toBeTypeOf("function");
      // Strict: no organization or user fields can be smuggled in.
      const input = action.name.includes("tag") ? { tag: "x" } : {};
      expect(action.inputSchema.safeParse({ ...input, organizationId: "o" }).success).toBe(false);
    }
  });

  it("maps actions to the existing RBAC permissions", () => {
    const permission = (name: (typeof ACTION_NAMES)[number]) =>
      actionRegistry.get(name)!.requiredPermission;
    expect(permission("add_customer_tag")).toBe("tag_customers");
    expect(permission("assign_conversation")).toBe("assign_conversations");
    expect(permission("change_conversation_status")).toBe("update_conversations");
    expect(permission("create_customer_note")).toBe("add_customer_notes");
  });

  it("validates inputs", () => {
    const schema = (name: (typeof ACTION_NAMES)[number]) => actionRegistry.get(name)!.inputSchema;
    expect(schema("change_conversation_status").safeParse({ status: "RESOLVED" }).success).toBe(
      true,
    );
    expect(schema("change_conversation_status").safeParse({ status: "DELETED" }).success).toBe(
      false,
    );
    expect(schema("assign_conversation").safeParse({ assigneeId: "nope" }).success).toBe(false);
    expect(schema("create_customer_note").safeParse({ content: "" }).success).toBe(false);
  });

  it("lets a test replace one executor without touching the others", () => {
    const registry = createActionRegistry({ create_customer_note: async () => ({ note: "stub" }) });
    expect(registry.get("create_customer_note")!.name).toBe("create_customer_note");
    expect(registry.get("add_customer_tag")!.execute).toBe(
      actionRegistry.get("add_customer_tag")!.execute,
    );
  });
});

describe("definition validation", () => {
  const base = {
    name: "Urgent routing",
    trigger: "conversation.priority_changed" as const,
    conditions: [{ field: "priority", operator: "equals" as const, value: "URGENT" }],
    actions: [{ type: "add_customer_tag" as const, input: { tag: "urgent" } }],
  };

  it("accepts a valid definition and normalizes action inputs", () => {
    const parsed = automationInputSchema.parse({
      ...base,
      actions: [{ type: "add_customer_tag", input: { tag: "  vip   customer " } }],
    });
    expect(validateDefinition(parsed).actions[0].input).toEqual({ tag: "vip customer" });
  });

  it("rejects unknown keys such as organizationId (never ignored)", () => {
    expect(automationInputSchema.safeParse({ ...base, organizationId: "x" }).success).toBe(false);
    expect(automationInputSchema.safeParse({ ...base, createdByUserId: "x" }).success).toBe(false);
  });

  it("reports every problem: bad condition, bad action input, wrong target", () => {
    const parsed = automationInputSchema.parse({
      ...base,
      trigger: "customer.created",
      conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
      actions: [
        { type: "assign_conversation", input: { assigneeId: "not-a-uuid" } },
        { type: "change_conversation_status", input: { status: "RESOLVED" } },
      ],
    });
    let problems: string[] = [];
    try {
      validateDefinition(parsed);
    } catch (error) {
      problems = (error as { details: { problems: string[] } }).details.problems;
    }
    const text = problems.join("\n");
    expect(text).toMatch(/not available for customer.created/);
    expect(text).toMatch(/needs a conversation/);
    expect(text).toMatch(/assigneeId/);
  });

  it("requires at least one action and bounds the list", () => {
    expect(automationInputSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
    expect(
      automationInputSchema.safeParse({ ...base, actions: Array(11).fill(base.actions[0]) })
        .success,
    ).toBe(false);
  });
});
