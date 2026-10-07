import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as assignRoute } from "@/app/api/conversations/[conversationId]/assign/route";
import { POST as unassignRoute } from "@/app/api/conversations/[conversationId]/unassign/route";
import {
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/conversations/[conversationId]/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/conversations/route";
import { GET as customerRoute } from "@/app/api/customers/[customerId]/route";
import { call } from "../helpers/api";
import {
  conversationRow,
  eventsOf,
  seedConversation,
  setupConversationTenants,
} from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { signOut } from "../helpers/mocks";
import { as, seedCustomer } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("conversations", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;
  const cid = (conversationId: string) => ({ conversationId });

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
    as(t.memberA);
  });
  afterAll(disconnectDatabase);

  const create = (body: Record<string, unknown>) => call(createRoute, { method: "POST", body });
  const patch = (id: string, body: Record<string, unknown>) =>
    call(patchRoute, { method: "PATCH", params: cid(id), body });

  describe("creation", () => {
    it("creates a conversation for a customer of the caller's organization with a CREATED event", async () => {
      const res = await create({ customerId: t.customerA.id, subject: "  Billing   question " });
      expect(res.status).toBe(201);
      expect(res.body.conversation).toMatchObject({
        subject: "Billing question",
        status: "OPEN",
        priority: "NORMAL",
        channel: "IN_APP",
        assignee: null,
        unread: false,
        customer: { id: t.customerA.id, name: "Alice Anders" },
      });

      const row = await conversationRow(res.body.conversation.id);
      expect(row.organizationId).toBe(t.orgA.id);
      expect(row.closedAt).toBeNull();
      const events = await eventsOf(row.id);
      expect(events.map((e) => e.type)).toEqual(["CONVERSATION_CREATED"]);
      expect(events[0]).toMatchObject({ actorType: "USER", actorId: t.memberA.id });
    });

    it("records an initial customer message and flags it for other members, not the creator", async () => {
      const res = await create({
        customerId: t.customerA.id,
        subject: "Login problem",
        priority: "HIGH",
        initialMessage: { body: "I cannot log in" },
      });
      expect(res.status).toBe(201);
      expect(res.body.conversation).toMatchObject({
        priority: "HIGH",
        lastMessagePreview: "I cannot log in",
        lastMessageSenderType: "CUSTOMER",
        unread: false, // the creator just saw it
      });
      const row = await conversationRow(res.body.conversation.id);
      expect(row.lastCustomerMessageAt).not.toBeNull();
      expect((await eventsOf(row.id)).map((e) => e.type)).toEqual([
        "CONVERSATION_CREATED",
        "MESSAGE_SENT",
      ]);

      as(t.otherMemberA);
      const other = await call(getRoute, { params: cid(row.id) });
      expect(other.body.conversation.unread).toBe(true);
    });

    it("supports an agent-written first message without marking it as a customer message", async () => {
      const res = await create({
        customerId: t.customerA.id,
        subject: "Outbound",
        initialMessage: { body: "Hello from us", from: "USER" },
      });
      const row = await conversationRow(res.body.conversation.id);
      expect(row.lastMessageSenderType).toBe("USER");
      expect(row.lastCustomerMessageAt).toBeNull();
      const { getDb } = await import("@/db/client");
      const message = await getDb().message.findFirstOrThrow({ where: { conversationId: row.id } });
      expect(message).toMatchObject({ senderType: "USER", senderUserId: t.memberA.id });
    });

    it("rejects an archived customer with 409 and a missing customer with 404, creating nothing", async () => {
      const archived = await seedCustomer(t.orgA.id, { firstName: "Gone", status: "ARCHIVED" });
      expect((await create({ customerId: archived.id, subject: "x" })).status).toBe(409);
      expect((await create({ customerId: crypto.randomUUID(), subject: "x" })).status).toBe(404);
      const { getDb } = await import("@/db/client");
      expect(await getDb().conversation.count()).toBe(0);
    });

    it.each([
      ["missing customer", { subject: "x" }],
      ["malformed customer id", { customerId: "nope", subject: "x" }],
      ["empty subject", { subject: "" }],
      ["blank subject", { subject: "   " }],
      ["too long subject", { subject: "x".repeat(201) }],
      ["invalid priority", { subject: "x", priority: "CRITICAL" }],
      ["unsupported channel", { subject: "x", channel: "EMAIL" }],
      ["organizationId", { subject: "x", organizationId: crypto.randomUUID() }],
      ["status", { subject: "x", status: "RESOLVED" }],
      ["assignedToUserId", { subject: "x", assignedToUserId: crypto.randomUUID() }],
      ["empty initial message", { subject: "x", initialMessage: { body: " " } }],
    ])("returns 400 for %s and creates nothing", async (_label, extra) => {
      const body = { customerId: t.customerA.id, ...extra };
      if (_label === "missing customer") delete (body as { customerId?: string }).customerId;
      const res = await create(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      const { getDb } = await import("@/db/client");
      expect(await getDb().conversation.count()).toBe(0);
    });

    it("returns 400 for malformed JSON and 401 when signed out", async () => {
      expect((await call(createRoute, { method: "POST", rawBody: "{oops" })).status).toBe(400);
      signOut();
      expect((await create({ customerId: t.customerA.id, subject: "x" })).status).toBe(401);
      expect((await call(listRoute)).status).toBe(401);
    });
  });

  describe("reading", () => {
    it("returns the conversation with customer and assignee", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id, {
        subject: "Hello",
        assignedToUserId: t.adminA.id,
      });
      const res = await call(getRoute, { params: cid(conversation.id) });
      expect(res.status).toBe(200);
      expect(res.body.conversation).toMatchObject({
        id: conversation.id,
        subject: "Hello",
        assignee: { id: t.adminA.id, email: "admina@example.com" },
        customer: { id: t.customerA.id, company: "Acme" },
      });
    });

    it("returns 404 for unknown and malformed ids", async () => {
      expect((await call(getRoute, { params: cid(crypto.randomUUID()) })).status).toBe(404);
      expect((await call(getRoute, { params: cid("nope") })).status).toBe(404);
    });
  });

  describe("updates and state transitions", () => {
    it("changes priority and subject and records one event per change", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id, { subject: "Old" });
      const res = await patch(conversation.id, { priority: "URGENT", subject: " New  subject " });
      expect(res.status).toBe(200);
      expect(res.body.conversation).toMatchObject({ priority: "URGENT", subject: "New subject" });

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.type).sort()).toEqual(["PRIORITY_CHANGED", "SUBJECT_CHANGED"]);
      expect(events.find((e) => e.type === "PRIORITY_CHANGED")?.metadata).toEqual({
        from: "NORMAL",
        to: "URGENT",
      });
      expect(events[0]).toMatchObject({ actorType: "USER", actorId: t.memberA.id });
    });

    it("OPEN -> PENDING keeps it open-ended (closedAt stays null) and logs the transition", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      const res = await patch(conversation.id, { status: "PENDING" });
      expect(res.status).toBe(200);
      expect(res.body.conversation).toMatchObject({ status: "PENDING", closedAt: null });
      expect((await eventsOf(conversation.id))[0]).toMatchObject({
        type: "STATUS_CHANGED",
        metadata: { from: "OPEN", to: "PENDING" },
      });
    });

    it("OPEN -> RESOLVED sets closedAt, and RESOLVED -> OPEN clears it", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      const before = Date.now();
      const resolved = await patch(conversation.id, { status: "RESOLVED" });
      expect(resolved.body.conversation.status).toBe("RESOLVED");
      const closedAt = new Date(resolved.body.conversation.closedAt).getTime();
      expect(closedAt).toBeGreaterThanOrEqual(before - 1000);
      expect((await conversationRow(conversation.id)).closedAt).not.toBeNull();

      const reopened = await patch(conversation.id, { status: "OPEN" });
      expect(reopened.body.conversation).toMatchObject({ status: "OPEN", closedAt: null });
      expect((await conversationRow(conversation.id)).closedAt).toBeNull();
      expect((await eventsOf(conversation.id)).map((e) => e.type)).toEqual([
        "STATUS_CHANGED",
        "STATUS_CHANGED",
      ]);
    });

    it("allows PENDING -> RESOLVED and PENDING -> OPEN", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id, { status: "PENDING" });
      expect((await patch(conversation.id, { status: "OPEN" })).status).toBe(200);
      await patch(conversation.id, { status: "PENDING" });
      expect((await patch(conversation.id, { status: "RESOLVED" })).status).toBe(200);
    });

    it("rejects RESOLVED -> PENDING with 409 and leaves the conversation unchanged", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id, {
        status: "RESOLVED",
      });
      const res = await patch(conversation.id, { status: "PENDING" });
      expect(res.status).toBe(409);
      expect(res.body.error.message).toMatch(/RESOLVED to PENDING/);
      expect((await conversationRow(conversation.id)).status).toBe("RESOLVED");
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it("does nothing (and logs nothing) when the values already match", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id, { subject: "Same" });
      const res = await patch(conversation.id, {
        status: "OPEN",
        priority: "NORMAL",
        subject: "Same",
      });
      expect(res.status).toBe(200);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it.each([
      ["empty body", {}],
      ["invalid status", { status: "CLOSED" }],
      ["invalid priority", { priority: "MEGA" }],
      ["blank subject", { subject: "  " }],
      ["organizationId", { organizationId: crypto.randomUUID() }],
      ["customerId", { customerId: crypto.randomUUID() }],
      ["assignedToUserId", { assignedToUserId: crypto.randomUUID() }],
      ["closedAt", { closedAt: null }],
    ])("rejects %s with 400 and changes nothing", async (_label, body) => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      expect((await patch(conversation.id, body)).status).toBe(400);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });
  });

  describe("assignment", () => {
    it("lets an ADMIN assign any member, then reassign, recording from/to", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      as(t.adminA);
      const first = await call(assignRoute, {
        method: "POST",
        params: cid(conversation.id),
        body: { userId: t.memberA.id },
      });
      expect(first.status).toBe(200);
      expect(first.body.conversation.assignee).toMatchObject({ id: t.memberA.id });
      await call(assignRoute, {
        method: "POST",
        params: cid(conversation.id),
        body: { userId: t.otherMemberA.id },
      });

      const events = await eventsOf(conversation.id);
      expect(events.map((e) => e.type)).toEqual(["ASSIGNED", "ASSIGNED"]);
      expect(events[1].metadata).toEqual({ from: t.memberA.id, to: t.otherMemberA.id });
    });

    it("lets a MEMBER claim an unassigned conversation for themselves", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      const res = await call(assignRoute, {
        method: "POST",
        params: cid(conversation.id),
        body: { userId: t.memberA.id },
      });
      expect(res.status).toBe(200);
      expect((await conversationRow(conversation.id)).assignedToUserId).toBe(t.memberA.id);
    });

    it("forbids a MEMBER from assigning others or taking over someone else's conversation", async () => {
      const free = await seedConversation(t.orgA.id, t.customerA.id);
      const taken = await seedConversation(t.orgA.id, t.customerA.id, {
        assignedToUserId: t.otherMemberA.id,
      });
      const toOther = await call(assignRoute, {
        method: "POST",
        params: cid(free.id),
        body: { userId: t.otherMemberA.id },
      });
      const takeOver = await call(assignRoute, {
        method: "POST",
        params: cid(taken.id),
        body: { userId: t.memberA.id },
      });
      expect([toOther.status, takeOver.status]).toEqual([403, 403]);
      expect((await conversationRow(free.id)).assignedToUserId).toBeNull();
      expect((await conversationRow(taken.id)).assignedToUserId).toBe(t.otherMemberA.id);
    });

    it("refuses an assignee who is not a member of the organization (including other tenants' users)", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      as(t.adminA);
      const foreign = await call(assignRoute, {
        method: "POST",
        params: cid(conversation.id),
        body: { userId: t.ownerB.id },
      });
      const unknown = await call(assignRoute, {
        method: "POST",
        params: cid(conversation.id),
        body: { userId: crypto.randomUUID() },
      });
      expect([foreign.status, unknown.status]).toEqual([404, 404]);
      expect((await conversationRow(conversation.id)).assignedToUserId).toBeNull();
    });

    it("unassigns: members only their own, admins anyone; unassigned is a no-op", async () => {
      const mine = await seedConversation(t.orgA.id, t.customerA.id, {
        assignedToUserId: t.memberA.id,
      });
      const theirs = await seedConversation(t.orgA.id, t.customerA.id, {
        assignedToUserId: t.otherMemberA.id,
      });
      const nobody = await seedConversation(t.orgA.id, t.customerA.id);

      expect((await call(unassignRoute, { method: "POST", params: cid(mine.id) })).status).toBe(
        200,
      );
      expect((await conversationRow(mine.id)).assignedToUserId).toBeNull();
      expect((await call(unassignRoute, { method: "POST", params: cid(theirs.id) })).status).toBe(
        403,
      );
      expect((await conversationRow(theirs.id)).assignedToUserId).toBe(t.otherMemberA.id);
      await call(unassignRoute, { method: "POST", params: cid(nobody.id) });
      expect(await eventsOf(nobody.id)).toHaveLength(0);

      as(t.adminA);
      expect((await call(unassignRoute, { method: "POST", params: cid(theirs.id) })).status).toBe(
        200,
      );
      expect((await eventsOf(theirs.id))[0]).toMatchObject({
        type: "UNASSIGNED",
        metadata: { from: t.otherMemberA.id },
      });
    });

    it("rejects malformed assignment bodies", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      for (const body of [
        {},
        { userId: "nope" },
        { userId: t.memberA.id, organizationId: t.orgB.id },
      ]) {
        expect(
          (await call(assignRoute, { method: "POST", params: cid(conversation.id), body })).status,
        ).toBe(400);
      }
    });
  });

  describe("Customer 360 integration", () => {
    it("lists the customer's recent conversations (own organization only) with counts", async () => {
      await seedConversation(t.orgA.id, t.customerA.id, {
        subject: "First",
        lastMessageAt: new Date("2026-01-01"),
      });
      await seedConversation(t.orgA.id, t.customerA.id, {
        subject: "Second",
        lastMessageAt: new Date("2026-02-01"),
      });
      await seedConversation(t.orgB.id, t.customerB.id, { subject: "Other tenant" });

      const res = await call(customerRoute, { params: { customerId: t.customerA.id } });
      expect(res.status).toBe(200);
      expect(res.body.conversations.map((c: { subject: string }) => c.subject)).toEqual([
        "Second",
        "First",
      ]);
      expect(res.body.counts.conversations).toBe(2);
      expect(res.body.conversations[0]).toHaveProperty("assignee");
      expect(JSON.stringify(res.body)).not.toContain("Other tenant");
    });
  });
});
