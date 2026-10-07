import { describe, expect, it } from "vitest";
import {
  assignConversationSchema,
  createConversationSchema,
  listConversationsQuerySchema,
  listMessagesQuerySchema,
  sendMessageSchema,
  updateConversationSchema,
} from "./schemas";

const customerId = crypto.randomUUID();

describe("createConversationSchema", () => {
  it("normalizes the subject and applies defaults", () => {
    expect(
      createConversationSchema.parse({ customerId, subject: "  Billing   question " }),
    ).toEqual({
      customerId,
      subject: "Billing question",
      priority: "NORMAL",
      channel: "IN_APP",
    });
  });

  it("defaults the initial message to a customer message", () => {
    const parsed = createConversationSchema.parse({
      customerId,
      subject: "x",
      initialMessage: { body: " hi " },
    });
    expect(parsed.initialMessage).toEqual({ body: "hi", from: "CUSTOMER" });
  });

  it.each([
    ["no customer", { subject: "x" }],
    ["blank subject", { customerId, subject: "  " }],
    ["long subject", { customerId, subject: "x".repeat(201) }],
    ["bad priority", { customerId, subject: "x", priority: "NOW" }],
    ["future channel", { customerId, subject: "x", channel: "EMAIL" }],
    ["organizationId", { customerId, subject: "x", organizationId: crypto.randomUUID() }],
    ["status", { customerId, subject: "x", status: "RESOLVED" }],
    ["assignee", { customerId, subject: "x", assignedToUserId: crypto.randomUUID() }],
  ])("rejects %s", (_label, input) => {
    expect(createConversationSchema.safeParse(input).success).toBe(false);
  });
});

describe("updateConversationSchema", () => {
  it("accepts subject, status and priority only", () => {
    expect(updateConversationSchema.safeParse({ status: "PENDING" }).success).toBe(true);
    expect(updateConversationSchema.safeParse({}).success).toBe(false);
    for (const field of ["customerId", "assignedToUserId", "closedAt", "organizationId", "id"]) {
      expect(updateConversationSchema.safeParse({ [field]: "x" }).success).toBe(false);
    }
  });
});

describe("sendMessageSchema", () => {
  it("defaults to a customer-facing agent message", () => {
    expect(sendMessageSchema.parse({ body: "  hello " })).toEqual({
      body: "hello",
      type: "MESSAGE",
      from: "USER",
    });
  });

  it("allows internal notes, customer messages, but not customer-written notes", () => {
    expect(sendMessageSchema.safeParse({ body: "x", type: "INTERNAL_NOTE" }).success).toBe(true);
    expect(sendMessageSchema.safeParse({ body: "x", from: "CUSTOMER" }).success).toBe(true);
    expect(
      sendMessageSchema.safeParse({ body: "x", type: "INTERNAL_NOTE", from: "CUSTOMER" }).success,
    ).toBe(false);
  });

  it.each([
    ["empty", { body: "" }],
    ["too long", { body: "x".repeat(10_001) }],
    ["sender id", { body: "x", senderUserId: crypto.randomUUID() }],
    ["sender type", { body: "x", senderType: "USER" }],
    ["AI sender", { body: "x", from: "AI_AGENT" }],
    ["system event type", { body: "x", type: "SYSTEM_EVENT" }],
    ["organization", { body: "x", organizationId: crypto.randomUUID() }],
  ])("rejects %s", (_label, input) => {
    expect(sendMessageSchema.safeParse(input).success).toBe(false);
  });
});

describe("assignConversationSchema", () => {
  it("requires a user id and nothing else", () => {
    expect(assignConversationSchema.safeParse({ userId: crypto.randomUUID() }).success).toBe(true);
    expect(assignConversationSchema.safeParse({ userId: "nope" }).success).toBe(false);
    expect(
      assignConversationSchema.safeParse({ userId: crypto.randomUUID(), role: "ADMIN" }).success,
    ).toBe(false);
  });
});

describe("listConversationsQuerySchema", () => {
  it("applies defaults and parses lists and the assignee shortcuts", () => {
    expect(
      listConversationsQuerySchema.parse({
        status: "OPEN,PENDING",
        priority: "HIGH",
        assignee: "me",
      }),
    ).toMatchObject({
      page: 1,
      pageSize: 25,
      sort: "lastMessageAt",
      order: "desc",
      status: ["OPEN", "PENDING"],
      priority: ["HIGH"],
      assignee: "me",
    });
    expect(listConversationsQuerySchema.parse({ assignee: "unassigned" }).assignee).toBe(
      "unassigned",
    );
    expect(
      listConversationsQuerySchema.parse({ assignee: crypto.randomUUID() }).assignee,
    ).toBeDefined();
  });

  it.each([
    { status: "DONE" },
    { priority: "MEGA" },
    { assignee: "everyone" },
    { channel: "SMS" },
    { customerId: "nope" },
    { sort: "subject" },
    { pageSize: "101" },
    { page: "0" },
  ])("rejects %j", (input) => {
    expect(listConversationsQuerySchema.safeParse(input).success).toBe(false);
  });

  it("ignores unknown parameters such as organizationId", () => {
    const parsed = listConversationsQuerySchema.parse({ organizationId: crypto.randomUUID() });
    expect("organizationId" in parsed).toBe(false);
  });
});

describe("listMessagesQuerySchema", () => {
  it("excludes internal notes by default and bounds the page size", () => {
    expect(listMessagesQuerySchema.parse({})).toEqual({ limit: 50, includeInternal: false });
    expect(listMessagesQuerySchema.parse({ includeInternal: "true" }).includeInternal).toBe(true);
    expect(listMessagesQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(listMessagesQuerySchema.safeParse({ limit: "201" }).success).toBe(false);
    expect(listMessagesQuerySchema.safeParse({ before: "nope" }).success).toBe(false);
  });
});
