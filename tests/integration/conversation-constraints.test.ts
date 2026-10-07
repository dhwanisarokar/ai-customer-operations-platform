import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as removeMemberRoute } from "@/app/api/organizations/[organizationId]/members/[userId]/route";
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

describeDb("conversation database integrity", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
  });
  afterAll(disconnectDatabase);

  describe("composite foreign keys keep every row inside one organization", () => {
    it("rejects a conversation that points at another organization's customer", async () => {
      const client = await db();
      await expect(
        client.conversation.create({
          data: {
            organizationId: t.orgA.id,
            customerId: t.customerB.id,
            subject: "x",
            lastMessageAt: new Date(),
          },
        }),
      ).rejects.toThrow();
      expect(await client.conversation.count()).toBe(0);
    });

    it("rejects a message, event or read state whose organization differs from the conversation's", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      const client = await db();
      await expect(
        client.message.create({
          data: {
            organizationId: t.orgB.id,
            conversationId: conversation.id,
            senderType: "CUSTOMER",
            body: "x",
          },
        }),
      ).rejects.toThrow();
      await expect(
        client.conversationEvent.create({
          data: {
            organizationId: t.orgB.id,
            conversationId: conversation.id,
            type: "MESSAGE_SENT",
          },
        }),
      ).rejects.toThrow();
      await expect(
        client.conversationReadState.create({
          data: {
            organizationId: t.orgB.id,
            conversationId: conversation.id,
            userId: t.ownerB.id,
            lastReadAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });

    it("rejects assigning a user who is not a member of the conversation's organization", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      await expect(
        (await db()).conversation.update({
          where: { id: conversation.id },
          data: { assignedToUserId: t.ownerB.id },
        }),
      ).rejects.toThrow();
      expect((await conversationRow(conversation.id)).assignedToUserId).toBeNull();
    });

    it("rejects a read state for a user who is not a member of the organization", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      await expect(
        (await db()).conversationReadState.create({
          data: {
            organizationId: t.orgA.id,
            conversationId: conversation.id,
            userId: t.ownerB.id,
            lastReadAt: new Date(),
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe("check constraints", () => {
    const insertConversation = async (columns: string, values: string) =>
      (await db()).$executeRawUnsafe(
        `INSERT INTO conversations (id, "organizationId", "customerId", "lastMessageAt", ${columns}) VALUES (gen_random_uuid(), '${t.orgA.id}', '${t.customerA.id}', now(), ${values})`,
      );

    it("rejects blank subjects and status/closedAt mismatches", async () => {
      await expect(insertConversation("subject", `'   '`)).rejects.toThrow();
      await expect(insertConversation("subject, status", `'x', 'RESOLVED'`)).rejects.toThrow();
      await expect(
        insertConversation('subject, status, "closedAt"', `'x', 'OPEN', now()`),
      ).rejects.toThrow();
      await expect(
        insertConversation('subject, status, "closedAt"', `'x', 'RESOLVED', now()`),
      ).resolves.toBe(1);
    });

    it("rejects invalid enum values", async () => {
      await expect(insertConversation("subject, priority", `'x', 'CRITICAL'`)).rejects.toThrow();
      await expect(insertConversation("subject, channel", `'x', 'EMAIL'`)).rejects.toThrow();
    });

    it("rejects blank bodies, non-user senders carrying a user id, and customer-written internal notes", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      const insert = async (sender: string, user: string, type: string, body = "hi") =>
        (await db()).$executeRawUnsafe(
          `INSERT INTO messages (id, "organizationId", "conversationId", "senderType", "senderUserId", "messageType", body)
           VALUES (gen_random_uuid(), '${t.orgA.id}', '${conversation.id}', '${sender}', ${user}, '${type}', '${body}')`,
        );
      await expect(insert("CUSTOMER", "NULL", "MESSAGE", "  ")).rejects.toThrow();
      await expect(insert("CUSTOMER", `'${t.memberA.id}'`, "MESSAGE")).rejects.toThrow();
      await expect(insert("CUSTOMER", "NULL", "INTERNAL_NOTE")).rejects.toThrow();
      await expect(insert("USER", `'${t.memberA.id}'`, "INTERNAL_NOTE")).resolves.toBe(1);
      await expect(insert("CUSTOMER", "NULL", "MESSAGE")).resolves.toBe(1);
    });
  });

  describe("cascades and retention", () => {
    it("removes conversations with their customer, including messages, events and read states", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      await seedMessage(t.orgA.id, conversation.id);
      const client = await db();
      await client.conversationEvent.create({
        data: {
          organizationId: t.orgA.id,
          conversationId: conversation.id,
          type: "CONVERSATION_CREATED",
        },
      });
      await client.conversationReadState.create({
        data: {
          organizationId: t.orgA.id,
          conversationId: conversation.id,
          userId: t.memberA.id,
          lastReadAt: new Date(),
        },
      });

      await client.customer.delete({ where: { id: t.customerA.id } });
      expect(await client.conversation.count()).toBe(0);
      expect(await client.message.count()).toBe(0);
      expect(await client.conversationEvent.count()).toBe(0);
      expect(await client.conversationReadState.count()).toBe(0);
    });

    it("deletes an organization with all its conversation data in one statement", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id, {
        assignedToUserId: t.memberA.id,
      });
      await seedMessage(t.orgA.id, conversation.id);
      const client = await db();
      await client.organization.delete({ where: { id: t.orgA.id } });
      expect(await client.conversation.count()).toBe(0);
      expect(await client.message.count()).toBe(0);
    });

    it("keeps a message when its sender user is deleted", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      const message = await seedMessage(t.orgA.id, conversation.id, {
        senderType: "USER",
        senderUserId: t.otherMemberA.id,
      });
      const client = await db();
      // Deleting a user is only possible once they hold no assignments (none here).
      await client.user.delete({ where: { id: t.otherMemberA.id } });
      const kept = await client.message.findUniqueOrThrow({ where: { id: message.id } });
      expect(kept.senderUserId).toBeNull();
    });
  });

  describe("removing an assigned member", () => {
    it("is blocked by the database while conversations are still assigned to them", async () => {
      await seedConversation(t.orgA.id, t.customerA.id, { assignedToUserId: t.memberA.id });
      await expect(
        (await db()).membership.delete({
          where: { userId_organizationId: { userId: t.memberA.id, organizationId: t.orgA.id } },
        }),
      ).rejects.toThrow();
    });

    it("is handled by the service: conversations are unassigned with an event, read state is cleaned up", async () => {
      const assigned = await seedConversation(t.orgA.id, t.customerA.id, {
        assignedToUserId: t.memberA.id,
      });
      const untouched = await seedConversation(t.orgA.id, t.customerA.id, {
        assignedToUserId: t.otherMemberA.id,
      });
      const client = await db();
      await client.conversationReadState.create({
        data: {
          organizationId: t.orgA.id,
          conversationId: assigned.id,
          userId: t.memberA.id,
          lastReadAt: new Date(),
        },
      });

      as(t.adminA);
      const res = await call(removeMemberRoute, {
        method: "DELETE",
        params: { organizationId: t.orgA.id, userId: t.memberA.id },
      });
      expect(res.status).toBe(204);

      expect((await conversationRow(assigned.id)).assignedToUserId).toBeNull();
      expect((await conversationRow(untouched.id)).assignedToUserId).toBe(t.otherMemberA.id);
      const [event] = await eventsOf(assigned.id);
      expect(event).toMatchObject({
        type: "UNASSIGNED",
        actorId: t.adminA.id,
        metadata: { from: t.memberA.id, reason: "member_removed" },
      });
      expect(await eventsOf(untouched.id)).toHaveLength(0);
      expect(await client.conversationReadState.count({ where: { userId: t.memberA.id } })).toBe(0);
      expect(
        await client.membership.count({
          where: { userId: t.memberA.id, organizationId: t.orgA.id },
        }),
      ).toBe(0);
    });
  });

  describe("indexes", () => {
    it("exist for the inbox query patterns", async () => {
      const rows = await (
        await db()
      ).$queryRaw<{ indexdef: string }[]>`
        SELECT indexdef FROM pg_indexes WHERE tablename IN ('conversations', 'messages', 'conversation_events')`;
      const definitions = rows.map((r) => r.indexdef).join(" | ");
      for (const columns of [
        '("organizationId", status, "lastMessageAt" DESC)',
        '("organizationId", "lastMessageAt" DESC)',
        '("organizationId", "assignedToUserId", status)',
        '("organizationId", priority, "lastMessageAt" DESC)',
        '("organizationId", "customerId", "lastMessageAt" DESC)',
        '("organizationId", "conversationId", "createdAt", id)',
      ]) {
        expect(definitions).toContain(columns);
      }
    });
  });
});
