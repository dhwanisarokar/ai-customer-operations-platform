import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as eventsRoute } from "@/app/api/conversations/[conversationId]/events/route";
import {
  GET as listMessagesRoute,
  POST as sendRoute,
} from "@/app/api/conversations/[conversationId]/messages/route";
import { POST as readRoute } from "@/app/api/conversations/[conversationId]/read/route";
import { GET as getRoute } from "@/app/api/conversations/[conversationId]/route";
import { call } from "../helpers/api";
import {
  conversationRow,
  eventsOf,
  seedConversation,
  seedMessage,
  setupConversationTenants,
} from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("messages, internal notes and read state", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;
  let conversation: Awaited<ReturnType<typeof seedConversation>>;
  const cid = () => ({ conversationId: conversation.id });
  const send = (body: Record<string, unknown>) =>
    call(sendRoute, { method: "POST", params: cid(), body });
  const list = (query: Record<string, string> = {}) =>
    call(listMessagesRoute, { params: cid(), query });
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
    conversation = await seedConversation(t.orgA.id, t.customerA.id);
    as(t.memberA);
  });
  afterAll(disconnectDatabase);

  describe("sending", () => {
    it("stores an agent message with the authenticated user as sender and updates the conversation", async () => {
      const res = await send({ body: "  Happy to help  " });
      expect(res.status).toBe(201);
      expect(res.body.message).toMatchObject({
        body: "Happy to help",
        senderType: "USER",
        messageType: "MESSAGE",
        senderUserId: t.memberA.id,
        sender: { id: t.memberA.id },
      });

      const row = await conversationRow(conversation.id);
      expect(row).toMatchObject({
        lastMessagePreview: "Happy to help",
        lastMessageSenderType: "USER",
        lastCustomerMessageAt: null,
      });
      expect(row.lastMessageAt.getTime()).toBe(new Date(res.body.message.createdAt).getTime());
      const stored = await (
        await db()
      ).message.findUniqueOrThrow({ where: { id: res.body.message.id } });
      expect(stored.organizationId).toBe(t.orgA.id);
      expect((await eventsOf(conversation.id)).map((e) => e.type)).toEqual(["MESSAGE_SENT"]);
    });

    it("takes the sender from the session: different members produce different senders", async () => {
      as(t.adminA);
      const res = await send({ body: "From the admin" });
      expect(res.body.message.senderUserId).toBe(t.adminA.id);
    });

    it("records a customer message (relayed by staff) without a sender user and tracks it for unread", async () => {
      const res = await send({ body: "Customer says hi", from: "CUSTOMER" });
      expect(res.status).toBe(201);
      expect(res.body.message).toMatchObject({
        senderType: "CUSTOMER",
        senderUserId: null,
        sender: null,
      });
      const row = await conversationRow(conversation.id);
      expect(row.lastCustomerMessageAt?.getTime()).toBe(
        new Date(res.body.message.createdAt).getTime(),
      );
      // The staff member who logged it is the event actor.
      expect((await eventsOf(conversation.id))[0]).toMatchObject({ actorId: t.memberA.id });
    });

    it.each([
      ["spoofed senderUserId", { body: "x", senderUserId: crypto.randomUUID() }],
      ["spoofed senderType", { body: "x", senderType: "SYSTEM" }],
      ["AI sender", { body: "x", from: "AI_AGENT" }],
      ["organizationId", { body: "x", organizationId: crypto.randomUUID() }],
      ["conversationId", { body: "x", conversationId: crypto.randomUUID() }],
      ["empty body", { body: "" }],
      ["blank body", { body: "  \n " }],
      ["oversized body", { body: "x".repeat(10_001) }],
      ["unknown type", { body: "x", type: "SYSTEM_EVENT" }],
      ["customer-authored note", { body: "x", type: "INTERNAL_NOTE", from: "CUSTOMER" }],
      ["missing body", {}],
    ])("returns 400 for %s and stores nothing", async (_label, body) => {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(await (await db()).message.count()).toBe(0);
      expect(await eventsOf(conversation.id)).toHaveLength(0);
    });

    it("never logs or stores message content in events", async () => {
      await send({ body: "my password is hunter2" });
      await send({ body: "private thought", type: "INTERNAL_NOTE" });
      expect(JSON.stringify(await eventsOf(conversation.id))).not.toMatch(
        /hunter2|private thought/,
      );
    });

    it("returns 404 for an unknown conversation", async () => {
      const res = await call(sendRoute, {
        method: "POST",
        params: { conversationId: crypto.randomUUID() },
        body: { body: "x" },
      });
      expect(res.status).toBe(404);
    });
  });

  describe("internal notes", () => {
    it("are stored as INTERNAL_NOTE, separate from customer-facing messages", async () => {
      await send({ body: "Visible reply" });
      const note = await send({ body: "Customer seems upset", type: "INTERNAL_NOTE" });
      expect(note.status).toBe(201);
      expect(note.body.message).toMatchObject({ messageType: "INTERNAL_NOTE", senderType: "USER" });
      expect((await eventsOf(conversation.id)).map((e) => e.type)).toEqual([
        "MESSAGE_SENT",
        "INTERNAL_NOTE_ADDED",
      ]);
    });

    it("never appear in the customer-facing history, which is the default", async () => {
      await send({ body: "Visible reply" });
      await send({ body: "SECRET staff note", type: "INTERNAL_NOTE" });

      const customerFacing = await list();
      expect(customerFacing.body.items.map((m: { body: string }) => m.body)).toEqual([
        "Visible reply",
      ]);
      expect(JSON.stringify(customerFacing.body)).not.toContain("SECRET");
      expect(customerFacing.body.total).toBe(1);

      const staffView = await list({ includeInternal: "true" });
      expect(staffView.body.items.map((m: { body: string }) => m.body)).toEqual([
        "Visible reply",
        "SECRET staff note",
      ]);
    });

    it("do not touch the inbox preview, last-message time or unread state, and are allowed on resolved conversations", async () => {
      await send({ body: "Visible reply" });
      const before = await conversationRow(conversation.id);
      const resolved = await seedConversation(t.orgA.id, t.customerA.id, { status: "RESOLVED" });

      await send({ body: "Staff only", type: "INTERNAL_NOTE" });
      const after = await conversationRow(conversation.id);
      expect(after.lastMessagePreview).toBe("Visible reply");
      expect(after.lastMessageAt.getTime()).toBe(before.lastMessageAt.getTime());

      const note = await call(sendRoute, {
        method: "POST",
        params: { conversationId: resolved.id },
        body: { body: "Post-mortem note", type: "INTERNAL_NOTE" },
      });
      expect(note.status).toBe(201);
      expect((await conversationRow(resolved.id)).status).toBe("RESOLVED");
    });
  });

  describe("lifecycle rules", () => {
    it("blocks agent replies on a resolved conversation with 409", async () => {
      const resolved = await seedConversation(t.orgA.id, t.customerA.id, { status: "RESOLVED" });
      const res = await call(sendRoute, {
        method: "POST",
        params: { conversationId: resolved.id },
        body: { body: "Too late" },
      });
      expect(res.status).toBe(409);
      expect(await (await db()).message.count({ where: { conversationId: resolved.id } })).toBe(0);
    });

    it.each(["PENDING", "RESOLVED"] as const)(
      "reopens a %s conversation when the customer writes back, with closedAt cleared and an event",
      async (status) => {
        const other = await seedConversation(t.orgA.id, t.customerA.id, { status });
        const res = await call(sendRoute, {
          method: "POST",
          params: { conversationId: other.id },
          body: { body: "Still broken", from: "CUSTOMER" },
        });
        expect(res.status).toBe(201);
        expect(await conversationRow(other.id)).toMatchObject({ status: "OPEN", closedAt: null });
        const events = await eventsOf(other.id);
        expect(events.map((e) => e.type)).toEqual(["MESSAGE_SENT", "STATUS_CHANGED"]);
        expect(events[1].metadata).toEqual({
          from: status,
          to: "OPEN",
          reason: "customer_message",
        });
      },
    );

    it("keeps an agent reply on a pending conversation pending", async () => {
      const pending = await seedConversation(t.orgA.id, t.customerA.id, { status: "PENDING" });
      await call(sendRoute, {
        method: "POST",
        params: { conversationId: pending.id },
        body: { body: "Waiting on you" },
      });
      expect((await conversationRow(pending.id)).status).toBe("PENDING");
    });
  });

  describe("unread state is per member", () => {
    it("flags new customer messages for everyone except whoever sent/read them", async () => {
      await send({ body: "Customer here", from: "CUSTOMER" });

      const unreadFor = async (user: { authProviderId: string }) => {
        as(user);
        return (await call(getRoute, { params: cid() })).body.conversation.unread;
      };
      expect(await unreadFor(t.memberA)).toBe(false); // logged it, so has seen it
      expect(await unreadFor(t.otherMemberA)).toBe(true);
      expect(await unreadFor(t.adminA)).toBe(true);

      as(t.otherMemberA);
      expect((await call(readRoute, { method: "POST", params: cid() })).status).toBe(204);
      expect(await unreadFor(t.otherMemberA)).toBe(false);
      // Reading is personal: the admin still has it unread.
      expect(await unreadFor(t.adminA)).toBe(true);
    });

    it("becomes unread again after another customer message", async () => {
      await send({ body: "One", from: "CUSTOMER" });
      as(t.otherMemberA);
      await call(readRoute, { method: "POST", params: cid() });
      as(t.memberA);
      await send({ body: "Two", from: "CUSTOMER" });
      as(t.otherMemberA);
      expect((await call(getRoute, { params: cid() })).body.conversation.unread).toBe(true);
    });

    it("does not count staff replies or internal notes as unread", async () => {
      await send({ body: "Agent reply" });
      await send({ body: "Note", type: "INTERNAL_NOTE" });
      as(t.otherMemberA);
      expect((await call(getRoute, { params: cid() })).body.conversation.unread).toBe(false);
    });

    it("is idempotent and rejects unknown conversations", async () => {
      expect((await call(readRoute, { method: "POST", params: cid() })).status).toBe(204);
      expect((await call(readRoute, { method: "POST", params: cid() })).status).toBe(204);
      expect(await (await db()).conversationReadState.count()).toBe(1);
      expect(
        (await call(readRoute, { method: "POST", params: { conversationId: crypto.randomUUID() } }))
          .status,
      ).toBe(404);
    });
  });

  describe("read marker", () => {
    it("only ever moves forward, even for late or out-of-order requests", async () => {
      const { conversationsRepository } = await import("@/server/repositories/conversations");
      const early = new Date("2026-01-01T00:00:00.000Z");
      const late = new Date("2026-02-01T00:00:00.000Z");
      const marker = async () =>
        (
          await (
            await db()
          ).conversationReadState.findUniqueOrThrow({
            where: {
              conversationId_userId: { conversationId: conversation.id, userId: t.memberA.id },
            },
          })
        ).lastReadAt;

      await conversationsRepository.markRead(t.orgA.id, conversation.id, t.memberA.id, late);
      await conversationsRepository.markRead(t.orgA.id, conversation.id, t.memberA.id, early);
      expect((await marker()).getTime()).toBe(late.getTime());

      const later = new Date("2026-03-01T00:00:00.000Z");
      await conversationsRepository.markRead(t.orgA.id, conversation.id, t.memberA.id, later);
      expect((await marker()).getTime()).toBe(later.getTime());
      expect(await (await db()).conversationReadState.count()).toBe(1);
    });
  });

  describe("pagination", () => {
    const base = new Date("2026-03-01T10:00:00.000Z").getTime();

    async function seedMany(count: number) {
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const message = await seedMessage(t.orgA.id, conversation.id, {
          body: `m${i}`,
          createdAt: new Date(base + i * 1000),
          ...(i % 2 ? { senderType: "USER", senderUserId: t.memberA.id } : {}),
        });
        ids.push(message.id);
      }
      return ids;
    }

    it("returns the newest page chronologically, with a cursor for older messages", async () => {
      await seedMany(7);
      const page1 = await list({ limit: "3" });
      expect(page1.body.items.map((m: { body: string }) => m.body)).toEqual(["m4", "m5", "m6"]);
      expect(page1.body).toMatchObject({ hasMore: true, total: 7 });
      expect(page1.body.nextCursor).toBe(page1.body.items[0].id);

      const page2 = await list({ limit: "3", before: page1.body.nextCursor });
      expect(page2.body.items.map((m: { body: string }) => m.body)).toEqual(["m1", "m2", "m3"]);
      const page3 = await list({ limit: "3", before: page2.body.nextCursor });
      expect(page3.body.items.map((m: { body: string }) => m.body)).toEqual(["m0"]);
      expect(page3.body).toMatchObject({ hasMore: false, nextCursor: null });
    });

    it("keeps a stable order for messages with identical timestamps", async () => {
      const same = new Date(base);
      for (let i = 0; i < 6; i++)
        await seedMessage(t.orgA.id, conversation.id, { body: `t${i}`, createdAt: same });
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 3; i++) {
        const page = await list({ limit: "2", ...(cursor ? { before: cursor } : {}) });
        seen.push(...page.body.items.map((m: { id: string }) => m.id));
        cursor = page.body.nextCursor ?? undefined;
      }
      expect(new Set(seen).size).toBe(6);
    });

    it("rejects invalid limits and cursors", async () => {
      await seedMany(2);
      expect((await list({ limit: "0" })).status).toBe(400);
      expect((await list({ limit: "201" })).status).toBe(400);
      expect((await list({ before: "nope" })).status).toBe(400);
      expect((await list({ before: crypto.randomUUID() })).status).toBe(400);
    });

    it("rejects a cursor that belongs to another conversation of the same organization", async () => {
      const other = await seedConversation(t.orgA.id, t.customerA.id);
      const foreign = await seedMessage(t.orgA.id, other.id, { body: "elsewhere" });
      await seedMany(2);
      expect((await list({ before: foreign.id })).status).toBe(400);
    });
  });

  describe("events", () => {
    it("lists the audit trail newest first with pagination", async () => {
      await send({ body: "a" });
      await send({ body: "b", type: "INTERNAL_NOTE" });
      const res = await call(eventsRoute, { params: cid(), query: { pageSize: "1" } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 2, totalPages: 2 });
      expect(res.body.items[0].type).toBe("INTERNAL_NOTE_ADDED");
    });
  });
});
