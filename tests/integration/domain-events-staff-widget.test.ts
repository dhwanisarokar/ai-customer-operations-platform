import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationInputSchema } from "@/server/automation/definition";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { requireOrganizationContext } from "@/server/auth/context";
import { runAsAutomation } from "@/server/events/bus";
import { OUTBOX_INITIAL_LEASE_MS, reconcileOutbox } from "@/server/events/outbox";
import { domainEventOutboxRepository } from "@/server/repositories/domain-event-outbox";
import { visitorSessionsRepository } from "@/server/repositories/visitor-sessions";
import { createAutomation } from "@/server/services/automations";
import {
  assignConversation,
  unassignConversation,
  updateConversation,
} from "@/server/services/conversations";
import { ensureVisitorCustomer } from "@/server/widget/visitor";
import type { VisitorContext } from "@/server/widget/session";
import { seedConversation } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("durable events: staff conversation changes and widget visitor customers", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let queue: MemoryAutomationQueue;
  let customerId: string;
  let conversationId: string;
  const db = async () => (await import("@/db/client")).getDb();
  const pastLease = () => new Date(Date.now() + OUTBOX_INITIAL_LEASE_MS + 1000);

  const ctxOf = async (user: Parameters<typeof as>[0]) => {
    as(user);
    return requireOrganizationContext();
  };
  const rows = async () =>
    (await db()).domainEventOutbox.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const types = async () => (await rows()).map((r) => r.type);

  async function automationFor(
    user: Parameters<typeof as>[0],
    trigger: string,
    conditions: unknown[] = [],
  ) {
    return createAutomation(
      await ctxOf(user),
      automationInputSchema.parse({
        name: `on ${trigger}`,
        trigger,
        conditions,
        actions: [{ type: "create_customer_note", input: { content: "fired" } }],
      }),
    );
  }
  const runsOf = async (automationId: string) =>
    (await db()).automationExecution.findMany({ where: { automationId } });

  /** Makes automation dispatch fail the way a crash or an outage would. */
  async function breakDispatch() {
    const engine = await import("@/server/automation/engine");
    return vi.spyOn(engine, "dispatchDomainEvent").mockRejectedValue(new Error("engine down"));
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
    queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    setAutomationQueueForTesting(queue);
    customerId = (await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@c.test" })).id;
    conversationId = (await seedConversation(t.orgA.id, customerId)).id;
  });

  afterEach(() => {
    setAutomationQueueForTesting(undefined);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  // ---- staff: status / priority ------------------------------------------------------------------------

  describe("staff status and priority changes", () => {
    it("record one durable event per real change, with the same payload, actor and order as before", async () => {
      const ctx = await ctxOf(t.adminA);
      await updateConversation(ctx, conversationId, { status: "PENDING", priority: "HIGH" });
      const events = await rows();
      expect(events.map((e) => e.type)).toEqual([
        "conversation.status_changed",
        "conversation.priority_changed",
      ]);
      expect(events[0].data).toEqual({
        conversationId,
        customerId,
        priority: "HIGH",
        status: "PENDING",
        assignee: null,
        previousStatus: "OPEN",
      });
      expect(events[1].data).toEqual({
        conversationId,
        customerId,
        priority: "HIGH",
        status: "PENDING",
        assignee: null,
        previousPriority: "NORMAL",
      });
      for (const e of events) {
        expect(e).toMatchObject({
          organizationId: t.orgA.id,
          actorUserId: t.adminA.id,
          causedByAutomation: false,
          attempts: 0,
        });
        expect(e.publishedAt).not.toBeNull(); // published right after the commit
      }
    });

    it("records nothing when nothing really changed (same values, subject only)", async () => {
      const ctx = await ctxOf(t.adminA);
      await updateConversation(ctx, conversationId, { status: "OPEN", priority: "NORMAL" });
      await updateConversation(ctx, conversationId, { subject: "A new subject" });
      expect(await rows()).toHaveLength(0);
    });

    it("an invalid transition fails and leaves no event and no change (rollback)", async () => {
      const ctx = await ctxOf(t.adminA);
      await (
        await db()
      ).conversation.update({
        where: { id: conversationId },
        data: { status: "RESOLVED", closedAt: new Date() },
      });
      await expect(
        updateConversation(ctx, conversationId, { status: "PENDING" }),
      ).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    });

    it("if recording the second event fails, the whole change rolls back: no status, priority, audit entry or event", async () => {
      const ctx = await ctxOf(t.adminA);
      const original = domainEventOutboxRepository.insert.bind(domainEventOutboxRepository);
      let calls = 0;
      vi.spyOn(domainEventOutboxRepository, "insert").mockImplementation(((
        ...args: Parameters<typeof original>
      ) => {
        calls += 1;
        if (calls === 2) throw new Error("outbox unavailable");
        return original(...args);
      }) as never);
      await expect(
        updateConversation(ctx, conversationId, { status: "PENDING", priority: "URGENT" }),
      ).rejects.toThrow("outbox unavailable");
      vi.restoreAllMocks();
      const client = await db();
      expect(
        await client.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
      ).toMatchObject({
        status: "OPEN",
        priority: "NORMAL",
      });
      expect(await client.conversationEvent.count({ where: { conversationId } })).toBe(0);
      expect(await rows()).toHaveLength(0);
    });

    it("a process failure after the commit loses nothing: the change stands and the reconciler publishes the event", async () => {
      const automation = await automationFor(t.adminA, "conversation.status_changed", [
        { field: "status", operator: "equals", value: "RESOLVED" },
      ]);
      const ctx = await ctxOf(t.adminA);
      const spy = await breakDispatch();
      const result = await updateConversation(ctx, conversationId, { status: "RESOLVED" });
      expect(result.status).toBe("RESOLVED"); // the request itself succeeded
      const [pending] = await rows();
      expect(pending).toMatchObject({
        publishedAt: null,
        attempts: 1,
        lastError: "publish_failed",
      });
      spy.mockRestore();

      expect((await reconcileOutbox()).claimed).toBe(0); // lease still held by the failed attempt
      expect(await reconcileOutbox({ now: pastLease() })).toEqual({
        claimed: 1,
        published: 1,
        failed: 0,
      });
      await queue.drain();
      const runs = await runsOf(automation.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].eventId).toBe(pending.id); // the SAME event id, preserved
      expect((await rows())[0].data).toEqual(pending.data); // payload unchanged by the retry
    });

    it("duplicate publication of one event cannot run an automation twice", async () => {
      const automation = await automationFor(t.adminA, "conversation.status_changed");
      const ctx = await ctxOf(t.adminA);
      await updateConversation(ctx, conversationId, { status: "PENDING" });
      await queue.drain();
      const [event] = await rows();
      // Pretend publication was never marked (a crash right after dispatch), twice over.
      for (let i = 0; i < 2; i++) {
        await (
          await db()
        ).domainEventOutbox.update({
          where: { id: event.id },
          data: { publishedAt: null, leaseUntil: new Date(0) },
        });
        await reconcileOutbox();
        await queue.drain();
      }
      expect(await runsOf(automation.id)).toHaveLength(1);
    });

    it("two concurrent workers publish each event once and create one execution per event", async () => {
      const automation = await automationFor(t.adminA, "conversation.status_changed");
      const ctx = await ctxOf(t.adminA);
      const spy = await breakDispatch();
      await updateConversation(ctx, conversationId, { status: "PENDING" });
      await updateConversation(ctx, conversationId, { status: "OPEN" });
      await updateConversation(ctx, conversationId, { status: "RESOLVED" });
      spy.mockRestore();
      const [a, b] = await Promise.all([
        reconcileOutbox({ now: pastLease() }),
        reconcileOutbox({ now: pastLease() }),
      ]);
      expect(a.claimed + b.claimed).toBe(3);
      await queue.drain();
      const runs = await runsOf(automation.id);
      expect(runs).toHaveLength(3);
      expect(new Set(runs.map((r) => r.eventId)).size).toBe(3);
    });

    it("an automation's own change is recorded as automation-caused and never triggers automations, even when retried", async () => {
      const automation = await automationFor(t.adminA, "conversation.status_changed");
      const ctx = await ctxOf(t.adminA);
      const spy = await breakDispatch();
      await runAsAutomation("auto-1", () =>
        updateConversation(ctx, conversationId, { status: "PENDING" }),
      );
      spy.mockRestore();
      const [event] = await rows();
      expect(event.causedByAutomation).toBe(true);
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      expect(await runsOf(automation.id)).toHaveLength(0);
    });

    it("concurrent updates are applied in turn: one reopen-style change, one event, correct previous value", async () => {
      const ctx = await ctxOf(t.adminA);
      const results = await Promise.allSettled(
        [1, 2, 3, 4].map(() => updateConversation(ctx, conversationId, { status: "RESOLVED" })),
      );
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      const events = await rows();
      expect(events).toHaveLength(1);
      expect(events[0].data).toMatchObject({ previousStatus: "OPEN", status: "RESOLVED" });
      expect(
        await (
          await db()
        ).conversationEvent.count({ where: { conversationId, type: "STATUS_CHANGED" } }),
      ).toBe(1);
    });
  });

  // ---- staff: assignment -------------------------------------------------------------------------------

  describe("staff assignment", () => {
    it("records conversation.assigned with the same payload and actor, durably", async () => {
      const ctx = await ctxOf(t.adminA);
      await assignConversation(ctx, conversationId, t.memberA.id);
      const [event] = await rows();
      expect(event).toMatchObject({
        type: "conversation.assigned",
        organizationId: t.orgA.id,
        actorUserId: t.adminA.id,
        causedByAutomation: false,
      });
      expect(event.publishedAt).not.toBeNull();
      expect(event.data).toEqual({
        conversationId,
        customerId,
        assignee: t.memberA.id,
        previousAssignee: null,
        status: "OPEN",
        priority: "NORMAL",
      });
    });

    it("assigning the same person again records nothing", async () => {
      const ctx = await ctxOf(t.adminA);
      await assignConversation(ctx, conversationId, t.memberA.id);
      await assignConversation(ctx, conversationId, t.memberA.id);
      expect(await types()).toEqual(["conversation.assigned"]);
    });

    it("a refused assignment (not a member / not allowed) leaves no event", async () => {
      const ctx = await ctxOf(t.adminA);
      await expect(assignConversation(ctx, conversationId, t.ownerB.id)).rejects.toThrow();
      const member = await ctxOf(t.memberA);
      await expect(assignConversation(member, conversationId, t.adminA.id)).rejects.toThrow();
      expect(await rows()).toHaveLength(0);
    });

    it("if the event cannot be recorded the assignment rolls back (no half-assigned conversation)", async () => {
      const ctx = await ctxOf(t.adminA);
      vi.spyOn(domainEventOutboxRepository, "insert").mockRejectedValue(
        new Error("outbox unavailable"),
      );
      await expect(assignConversation(ctx, conversationId, t.memberA.id)).rejects.toThrow();
      vi.restoreAllMocks();
      const conversation = await (
        await db()
      ).conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(conversation.assignedToUserId).toBeNull();
      expect(await rows()).toHaveLength(0);
    });

    it("survives a failure after the commit and is delivered once by the reconciler", async () => {
      const automation = await automationFor(t.adminA, "conversation.assigned");
      const ctx = await ctxOf(t.adminA);
      const spy = await breakDispatch();
      await assignConversation(ctx, conversationId, t.memberA.id);
      spy.mockRestore();
      await reconcileOutbox({ now: pastLease() });
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      expect(await runsOf(automation.id)).toHaveLength(1);
    });

    it("concurrent assignments form a consistent chain of previous assignees", async () => {
      const ctx = await ctxOf(t.adminA);
      await Promise.all([
        assignConversation(ctx, conversationId, t.memberA.id),
        assignConversation(ctx, conversationId, t.ownerA.id),
      ]);
      const events = await rows();
      expect(events).toHaveLength(2);
      const data = events.map(
        (e) => e.data as { assignee: string; previousAssignee: string | null },
      );
      const first = data.find((d) => d.previousAssignee === null)!;
      const second = data.find((d) => d.previousAssignee !== null)!;
      expect(second.previousAssignee).toBe(first.assignee);
      const final = await (
        await db()
      ).conversation.findUniqueOrThrow({ where: { id: conversationId } });
      expect(final.assignedToUserId).toBe(second.assignee);
    });

    it("unassigning has no domain event (no such trigger exists) and still works", async () => {
      const ctx = await ctxOf(t.adminA);
      await assignConversation(ctx, conversationId, t.memberA.id);
      const result = await unassignConversation(ctx, conversationId);
      expect(result.assignee).toBeNull();
      expect(await types()).toEqual(["conversation.assigned"]);
    });
  });

  // ---- tenant isolation --------------------------------------------------------------------------------

  describe("tenant isolation", () => {
    it("another organization's conversation cannot be changed, and events never cross organizations", async () => {
      const customerB = await seedCustomer(t.orgB.id, { firstName: "Bob", email: "bob@b.test" });
      const conversationB = (await seedConversation(t.orgB.id, customerB.id)).id;
      const automationB = await automationFor(t.ownerB, "conversation.status_changed");

      const ctx = await ctxOf(t.adminA);
      await expect(
        updateConversation(ctx, conversationB, { status: "RESOLVED" }),
      ).rejects.toThrow();
      await expect(assignConversation(ctx, conversationB, t.adminA.id)).rejects.toThrow();
      expect(await rows()).toHaveLength(0);

      // A's own change: its event belongs to A, and B's automation for the same trigger does not fire.
      await updateConversation(ctx, conversationId, { status: "RESOLVED" });
      await queue.drain();
      expect((await rows()).every((e) => e.organizationId === t.orgA.id)).toBe(true);
      expect(await runsOf(automationB.id)).toHaveLength(0);
    });

    it("a redelivered event still triggers only its own organization's automations", async () => {
      const customerB = await seedCustomer(t.orgB.id, { firstName: "Bob", email: "bob@b.test" });
      await seedConversation(t.orgB.id, customerB.id);
      const automationA = await automationFor(t.adminA, "conversation.status_changed");
      const automationB = await automationFor(t.ownerB, "conversation.status_changed");
      const ctx = await ctxOf(t.adminA);
      const spy = await breakDispatch();
      await updateConversation(ctx, conversationId, { status: "PENDING" });
      spy.mockRestore();
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      expect(await runsOf(automationA.id)).toHaveLength(1);
      expect(await runsOf(automationB.id)).toHaveLength(0);
    });
  });

  // ---- widget visitor customer -------------------------------------------------------------------------

  describe("widget visitor customer.created", () => {
    async function visitor(over: { visitorEmail?: string; visitorName?: string } = {}) {
      const session = await visitorSessionsRepository.create(t.orgA.id, {
        tokenHash: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 3600_000),
      });
      if (over.visitorEmail || over.visitorName) {
        await visitorSessionsRepository.setIdentity(t.orgA.id, session.id, over);
      }
      const fresh = (await visitorSessionsRepository.findById(t.orgA.id, session.id))!;
      return { session: fresh, organizationId: t.orgA.id, widget: {} } as unknown as VisitorContext;
    }
    const placeholders = async () =>
      (await db()).customer.findMany({ where: { organizationId: t.orgA.id, source: "web_chat" } });

    it("creates the placeholder customer, links the session and records the durable event with the same payload", async () => {
      const v = await visitor();
      const id = await ensureVisitorCustomer(v);
      const client = await db();
      const session = await client.visitorSession.findUniqueOrThrow({
        where: { id: v.session.id },
      });
      expect(session.customerId).toBe(id);
      const [event] = await rows();
      expect(event).toMatchObject({
        type: "customer.created",
        organizationId: t.orgA.id,
        actorUserId: null,
        causedByAutomation: false,
      });
      expect(event.publishedAt).not.toBeNull();
      expect(event.data).toEqual({
        customerId: id,
        status: "ACTIVE",
        company: null,
        source: "web_chat",
      });
    });

    it("rolls back completely when the event cannot be recorded: no customer, no link", async () => {
      const v = await visitor();
      vi.spyOn(domainEventOutboxRepository, "insert").mockRejectedValue(
        new Error("outbox unavailable"),
      );
      await expect(ensureVisitorCustomer(v)).rejects.toThrow("outbox unavailable");
      vi.restoreAllMocks();
      expect(await placeholders()).toHaveLength(0);
      expect(
        (await (await db()).visitorSession.findUniqueOrThrow({ where: { id: v.session.id } }))
          .customerId,
      ).toBeNull();
      expect(await rows()).toHaveLength(0);
    });

    it("after a failure post-commit the customer exists and the reconciler delivers the event once", async () => {
      const automation = await automationFor(t.adminA, "customer.created", [
        { field: "source", operator: "equals", value: "web_chat" },
      ]);
      const v = await visitor();
      const spy = await breakDispatch();
      const id = await ensureVisitorCustomer(v);
      expect(id).toBeTruthy();
      spy.mockRestore();
      const [pending] = await rows();
      expect(pending.publishedAt).toBeNull();
      await reconcileOutbox({ now: pastLease() });
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      const runs = await runsOf(automation.id);
      expect(runs).toHaveLength(1);
      expect(runs[0].eventId).toBe(pending.id);
    });

    it("concurrent requests of one session create ONE customer and ONE event (a lost race leaves no orphan)", async () => {
      const v = await visitor();
      // Each concurrent request holds its own copy of the session record, as in production.
      const copies = [1, 2, 3, 4].map(
        () => ({ ...v, session: { ...v.session } }) as VisitorContext,
      );
      const ids = await Promise.all(copies.map((c) => ensureVisitorCustomer(c)));
      expect(new Set(ids).size).toBe(1);
      expect(await placeholders()).toHaveLength(1);
      expect(await types()).toEqual(["customer.created"]);
    });

    it("an email that already belongs to a customer reuses it: no new customer, no event", async () => {
      const v = await visitor({ visitorEmail: "eve@c.test" });
      const id = await ensureVisitorCustomer(v);
      expect(id).toBe(customerId);
      expect(await placeholders()).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
      expect(
        (await (await db()).visitorSession.findUniqueOrThrow({ where: { id: v.session.id } }))
          .customerId,
      ).toBe(customerId);
    });

    it("keeps working once linked: a second call returns the same customer without a second event", async () => {
      const v = await visitor();
      const first = await ensureVisitorCustomer(v);
      const second = await ensureVisitorCustomer(v);
      expect(second).toBe(first);
      expect(await rows()).toHaveLength(1);
    });

    it("the event belongs to the visitor's organization only", async () => {
      const automationB = await automationFor(t.ownerB, "customer.created");
      await ensureVisitorCustomer(await visitor());
      await queue.drain();
      expect((await rows()).every((e) => e.organizationId === t.orgA.id)).toBe(true);
      expect(await runsOf(automationB.id)).toHaveLength(0);
    });
  });
});
