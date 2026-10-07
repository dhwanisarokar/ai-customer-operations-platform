import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { GET as eventsRoute } from "@/app/api/conversations/[conversationId]/events/route";
import { POST as assignRoute } from "@/app/api/conversations/[conversationId]/assign/route";
import {
  GET as listMessagesRoute,
  POST as sendRoute,
} from "@/app/api/conversations/[conversationId]/messages/route";
import { POST as readRoute } from "@/app/api/conversations/[conversationId]/read/route";
import {
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/conversations/[conversationId]/route";
import { POST as unassignRoute } from "@/app/api/conversations/[conversationId]/unassign/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/conversations/route";
import { GET as customerRoute } from "@/app/api/customers/[customerId]/route";
import { call } from "../helpers/api";
import {
  conversationRow,
  eventsOf,
  seedConversation,
  seedMessage,
  setupConversationTenants,
} from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { session } from "../helpers/mocks";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("conversation tenant isolation", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;
  let convA: Awaited<ReturnType<typeof seedConversation>>;
  let convB: Awaited<ReturnType<typeof seedConversation>>;
  const cid = (id: string) => ({ conversationId: id });
  async function db() {
    return (await import("@/db/client")).getDb();
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
    convA = await seedConversation(t.orgA.id, t.customerA.id, { subject: "Mine" });
    convB = await seedConversation(t.orgB.id, t.customerB.id, { subject: "Secret B subject" });
    await seedMessage(t.orgB.id, convB.id, { body: "Secret B message", senderType: "CUSTOMER" });
    await seedMessage(t.orgB.id, convB.id, {
      body: "Secret B internal note",
      senderType: "USER",
      senderUserId: t.ownerB.id,
      messageType: "INTERNAL_NOTE",
    });
    // Highest privilege in org A, so only tenancy (not RBAC) can cause a denial.
    as(t.ownerA);
  });
  afterAll(disconnectDatabase);

  it("allows organization A to use its own conversation", async () => {
    expect((await call(getRoute, { params: cid(convA.id) })).status).toBe(200);
    expect(
      (await call(sendRoute, { method: "POST", params: cid(convA.id), body: { body: "hi" } }))
        .status,
    ).toBe(201);
  });

  it("makes organization B's conversation indistinguishable from a nonexistent one", async () => {
    const foreign = await call(getRoute, { params: cid(convB.id) });
    const missing = await call(getRoute, { params: cid(crypto.randomUUID()) });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe(missing.body.error.code);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    expect(JSON.stringify(foreign.body)).not.toContain("Secret B");
  });

  it("blocks every endpoint of organization B's conversation (read, messages, notes, events)", async () => {
    const params = cid(convB.id);
    const results = await Promise.all([
      call(getRoute, { params }),
      call(listMessagesRoute, { params }),
      call(listMessagesRoute, { params, query: { includeInternal: "true" } }),
      call(eventsRoute, { params }),
      call(readRoute, { method: "POST", params }),
    ]);
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 404, 404]);
    for (const r of results) expect(JSON.stringify(r.body)).not.toMatch(/Secret B/);
  });

  it("blocks sending messages and internal notes into organization B's conversation", async () => {
    const message = await call(sendRoute, {
      method: "POST",
      params: cid(convB.id),
      body: { body: "intrusion" },
    });
    const note = await call(sendRoute, {
      method: "POST",
      params: cid(convB.id),
      body: { body: "intrusion note", type: "INTERNAL_NOTE" },
    });
    const customerMsg = await call(sendRoute, {
      method: "POST",
      params: cid(convB.id),
      body: { body: "forged", from: "CUSTOMER" },
    });
    expect([message.status, note.status, customerMsg.status]).toEqual([404, 404, 404]);
    expect(await (await db()).message.count({ where: { conversationId: convB.id } })).toBe(2);
    expect(await eventsOf(convB.id)).toHaveLength(0);
  });

  it("blocks changing status, priority, subject and assignment of organization B's conversation", async () => {
    const patch = await call(patchRoute, {
      method: "PATCH",
      params: cid(convB.id),
      body: { status: "RESOLVED", priority: "URGENT", subject: "hijacked" },
    });
    const assign = await call(assignRoute, {
      method: "POST",
      params: cid(convB.id),
      body: { userId: t.ownerA.id },
    });
    const unassign = await call(unassignRoute, { method: "POST", params: cid(convB.id) });
    expect([patch.status, assign.status, unassign.status]).toEqual([404, 404, 404]);
    expect(await conversationRow(convB.id)).toMatchObject({
      subject: "Secret B subject",
      status: "OPEN",
      priority: "NORMAL",
      assignedToUserId: null,
      closedAt: null,
    });
  });

  it("blocks creating a conversation for organization B's customer", async () => {
    const res = await call(createRoute, {
      method: "POST",
      body: { customerId: t.customerB.id, subject: "Sneaky" },
    });
    expect(res.status).toBe(404);
    expect(await (await db()).conversation.count({ where: { subject: "Sneaky" } })).toBe(0);
  });

  it("rejects an assignee from another organization", async () => {
    const res = await call(assignRoute, {
      method: "POST",
      params: cid(convA.id),
      body: { userId: t.ownerB.id },
    });
    expect(res.status).toBe(404);
    expect((await conversationRow(convA.id)).assignedToUserId).toBeNull();
  });

  it("rejects a message cursor from organization B", async () => {
    const foreign = await (
      await db()
    ).message.findFirstOrThrow({ where: { conversationId: convB.id } });
    const res = await call(listMessagesRoute, {
      params: cid(convA.id),
      query: { before: foreign.id },
    });
    expect(res.status).toBe(400);
  });

  it("lists only the caller's organization and ignores organizationId in the query string", async () => {
    const list = await call(listRoute, { query: { organizationId: t.orgB.id } });
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([convA.id]);
    expect((await call(listRoute, { query: { q: "Secret" } })).body.total).toBe(0);
    expect((await call(listRoute, { query: { customerId: t.customerB.id } })).body.total).toBe(0);
  });

  it("rejects client-supplied organization and sender identity in bodies", async () => {
    const withOrg = await call(createRoute, {
      method: "POST",
      body: { customerId: t.customerA.id, subject: "x", organizationId: t.orgB.id },
    });
    const withSender = await call(sendRoute, {
      method: "POST",
      params: cid(convA.id),
      body: { body: "x", senderUserId: t.ownerB.id },
    });
    expect([withOrg.status, withSender.status]).toEqual([400, 400]);
    expect(await (await db()).message.count({ where: { conversationId: convA.id } })).toBe(0);
  });

  it("does not leak organization B conversations through Customer 360", async () => {
    const own = await call(customerRoute, { params: { customerId: t.customerA.id } });
    expect(own.body.conversations.map((c: { id: string }) => c.id)).toEqual([convA.id]);
    const foreign = await call(customerRoute, { params: { customerId: t.customerB.id } });
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain("Secret B");
  });

  it("does not let a forged active-organization preference reach organization B", async () => {
    session.activeOrganizationId = t.orgB.id; // ownerA is not a member of org B
    expect((await call(getRoute, { params: cid(convB.id) })).status).toBe(404);
    const created = await call(createRoute, {
      method: "POST",
      body: { customerId: t.customerA.id, subject: "Lands in A" },
    });
    expect(created.status).toBe(201);
    expect((await conversationRow(created.body.conversation.id)).organizationId).toBe(t.orgA.id);
  });

  it("keeps read state per organization member and never across tenants", async () => {
    await call(readRoute, { method: "POST", params: cid(convA.id) });
    const rows = await (await db()).conversationReadState.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ organizationId: t.orgA.id, userId: t.ownerA.id });
  });
});
