import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listRoute, POST as createRoute } from "@/app/api/automations/route";
import {
  DELETE as deleteRoute,
  GET as getRoute,
  PATCH as patchRoute,
} from "@/app/api/automations/[automationId]/route";
import { POST as enableRoute } from "@/app/api/automations/[automationId]/enable/route";
import { POST as disableRoute } from "@/app/api/automations/[automationId]/disable/route";
import { POST as testRoute } from "@/app/api/automations/[automationId]/test/route";
import { GET as executionsRoute } from "@/app/api/automations/[automationId]/executions/route";
import { GET as executionRoute } from "@/app/api/automations/[automationId]/executions/[executionId]/route";
import { createActionRegistry } from "@/server/automation/actions";
import { dispatchDomainEvent } from "@/server/automation/engine";
import { automationInputSchema } from "@/server/automation/definition";
import { ensureInlineWorker, setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { processAutomationJob } from "@/server/automation/runner";
import { requireOrganizationContext } from "@/server/auth/context";
import { createConversationSchema } from "@/features/conversations/schemas";
import { createCustomerSchema, updateCustomerSchema } from "@/features/customers/schemas";
import { automationExecutionsRepository } from "@/server/repositories/automation-executions";
import { membershipsRepository } from "@/server/repositories/memberships";
import { sendMessage } from "@/server/services/conversation-messages";
import {
  assignConversation,
  createConversation,
  updateConversation,
} from "@/server/services/conversations";
import {
  createAutomation,
  getExecution,
  setAutomationEnabled,
} from "@/server/services/automations";
import { addTagToCustomer, removeTagFromCustomer } from "@/server/services/customer-tags";
import { createCustomer, updateCustomer } from "@/server/services/customers";
import { call } from "../helpers/api";
import { eventsOf, seedConversation, setupConversationTenants } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { signOut } from "../helpers/mocks";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type Tenants = Awaited<ReturnType<typeof setupConversationTenants>>;

describeDb("automations: engine, worker, API and security", () => {
  let t: Tenants;
  let queue: MemoryAutomationQueue;

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
    queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    setAutomationQueueForTesting(queue);
  });
  afterEach(() => setAutomationQueueForTesting(undefined));
  afterAll(disconnectDatabase);

  const db = async () => (await import("@/db/client")).getDb();
  const ctxOf = async (user: { authProviderId: string }) => {
    as(user);
    return requireOrganizationContext();
  };

  const urgentRouting = (overrides: Record<string, unknown> = {}) => ({
    name: "Urgent conversation routing",
    description: "Tag and assign urgent conversations",
    trigger: "conversation.priority_changed",
    conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
    actions: [
      { type: "add_customer_tag", input: { tag: "urgent" } },
      { type: "assign_conversation", input: { assigneeId: t.memberA.id } },
    ],
    ...overrides,
  });

  async function makeAutomation(
    user: { authProviderId: string } = t.adminA,
    definition: Record<string, unknown> = urgentRouting(),
  ) {
    return createAutomation(await ctxOf(user), automationInputSchema.parse(definition));
  }

  const executions = async (automationId?: string) =>
    (await db()).automationExecution.findMany({
      where: automationId ? { automationId } : {},
      orderBy: { createdAt: "asc" },
    });
  const tagsOf = async (customerId = t.customerA.id) =>
    (await db()).customerTag.findMany({ where: { customerId }, include: { tag: true } });
  const conversationRow = async (id: string) =>
    (await db()).conversation.findUniqueOrThrow({ where: { id } });

  async function newConversation(overrides: Parameters<typeof seedConversation>[2] = {}) {
    return seedConversation(t.orgA.id, t.customerA.id, overrides);
  }
  async function setPriority(
    conversationId: string,
    priority: "LOW" | "NORMAL" | "HIGH" | "URGENT",
    user: { authProviderId: string } = t.memberA,
  ) {
    await updateConversation(await ctxOf(user), conversationId, { priority });
    await queue.drain();
  }

  // -------------------------------------------------------------------------------------------
  describe("acceptance scenario: urgent conversation routing", () => {
    it("priority -> URGENT emits the event, matches, queues, runs both actions, COMPLETED", async () => {
      const automation = await makeAutomation();
      const conversation = await newConversation();

      await setPriority(conversation.id, "URGENT");

      const [run, ...rest] = await executions(automation.id);
      expect(rest).toHaveLength(0);
      expect(run).toMatchObject({
        status: "COMPLETED",
        eventType: "conversation.priority_changed",
        attempts: 1,
        errorCode: null,
      });
      expect(run.startedAt).toBeTruthy();
      expect(run.completedAt).toBeTruthy();

      // Tag added and conversation assigned, by the existing services.
      expect((await tagsOf()).map((link) => link.tag.name)).toEqual(["urgent"]);
      expect((await conversationRow(conversation.id)).assignedToUserId).toBe(t.memberA.id);

      // History makes the run debuggable.
      expect(run.conditionResults).toEqual([
        {
          field: "priority",
          operator: "equals",
          expected: "URGENT",
          actual: "URGENT",
          passed: true,
        },
      ]);
      expect(
        (run.actionResults as { action: string; status: string }[]).map((a) => [
          a.action,
          a.status,
        ]),
      ).toEqual([
        ["add_customer_tag", "completed"],
        ["assign_conversation", "completed"],
      ]);
      expect(run.eventData).toMatchObject({
        conversationId: conversation.id,
        customerId: t.customerA.id,
        priority: "URGENT",
        previousPriority: "NORMAL",
      });
      expect(run.definition).toMatchObject({ name: "Urgent conversation routing" });
    });

    it("loads the creator's context with ONE membership lookup and records every action's result", async () => {
      const contextLookup = vi.spyOn(membershipsRepository, "findContextSource");
      const progress = vi.spyOn(automationExecutionsRepository, "saveProgress");
      const automation = await makeAutomation();
      const conversation = await newConversation();
      await setPriority(conversation.id, "URGENT");

      expect(contextLookup).toHaveBeenCalledTimes(1);
      const [run] = await executions(automation.id);
      expect(run.status).toBe("COMPLETED");
      // Both actions are in the stored results even though the last one is written by the final update.
      expect((run.actionResults as { status: string }[]).map((a) => a.status)).toEqual([
        "completed",
        "completed",
      ]);
      // Only the first action needs a separate progress write; the last is stored with COMPLETED.
      expect(progress).toHaveBeenCalledTimes(1);
    });

    it("does nothing when the conditions do not match", async () => {
      const automation = await makeAutomation();
      const conversation = await newConversation();
      await setPriority(conversation.id, "HIGH");
      expect(await executions(automation.id)).toHaveLength(0);
      expect(await tagsOf()).toHaveLength(0);
    });

    it("replaying the same event never runs the automation twice", async () => {
      const automation = await makeAutomation();
      const conversation = await newConversation();
      const event = {
        id: randomUUID(),
        type: "conversation.priority_changed" as const,
        organizationId: t.orgA.id,
        occurredAt: new Date().toISOString(),
        actorUserId: t.memberA.id,
        causedByAutomation: false,
        data: {
          conversationId: conversation.id,
          customerId: t.customerA.id,
          priority: "URGENT",
          previousPriority: "NORMAL",
          status: "OPEN",
          assignee: null,
        },
      };

      const first = await dispatchDomainEvent(event);
      const second = await dispatchDomainEvent(event);
      const third = await dispatchDomainEvent(event);
      await queue.drain();

      expect(first).toEqual({ matched: 1, queued: 1, duplicates: 0 });
      expect(second).toEqual({ matched: 1, queued: 0, duplicates: 1 });
      expect(third.duplicates).toBe(1);
      expect(await executions(automation.id)).toHaveLength(1);
      expect((await eventsOf(conversation.id)).filter((e) => e.type === "ASSIGNED")).toHaveLength(
        1,
      );
      expect(await tagsOf()).toHaveLength(1);
    });

    it("the database itself rejects a second execution for the same (automation, event)", async () => {
      const automation = await makeAutomation();
      const data = {
        automationId: automation.id,
        eventId: randomUUID(),
        eventType: "conversation.priority_changed",
        eventData: {},
        definition: {},
        conditionResults: [],
      };
      expect(await automationExecutionsRepository.createIfAbsent(t.orgA.id, data)).not.toBeNull();
      expect(await automationExecutionsRepository.createIfAbsent(t.orgA.id, data)).toBeNull();
      // Same event id for ANOTHER automation is a different run.
      const other = await makeAutomation(t.adminA, urgentRouting({ name: "Second" }));
      expect(
        await automationExecutionsRepository.createIfAbsent(t.orgA.id, {
          ...data,
          automationId: other.id,
        }),
      ).not.toBeNull();
    });

    it("a disabled automation does not run, and enabling it again does", async () => {
      const automation = await makeAutomation();
      const adminCtx = await ctxOf(t.adminA);
      await setAutomationEnabled(adminCtx, automation.id, false);
      const conversation = await newConversation();

      await setPriority(conversation.id, "URGENT");
      expect(await executions(automation.id)).toHaveLength(0);
      expect(await tagsOf()).toHaveLength(0);

      await setAutomationEnabled(await ctxOf(t.adminA), automation.id, true);
      const another = await newConversation();
      await setPriority(another.id, "URGENT");
      expect(await executions(automation.id)).toHaveLength(1);
    });

    it("disabling after a run was queued but before it started cancels it", async () => {
      const automation = await makeAutomation();
      const conversation = await newConversation();
      const idle = new MemoryAutomationQueue({ backoffBaseMs: 0 }); // no worker: stays queued
      setAutomationQueueForTesting(idle);
      await ensureInlineWorker(async () => undefined); // keep the inline worker from starting
      await updateConversation(await ctxOf(t.memberA), conversation.id, { priority: "URGENT" });
      const [queued] = await executions(automation.id);
      expect(queued.status).toBe("QUEUED");

      await setAutomationEnabled(await ctxOf(t.adminA), automation.id, false);
      await processAutomationJob(
        { executionId: queued.id, organizationId: t.orgA.id },
        { attempt: 1, maxAttempts: 5 },
      );

      const [after] = await executions(automation.id);
      expect(after).toMatchObject({ status: "CANCELLED", errorCode: "AUTOMATION_DISABLED" });
      expect(await tagsOf()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("triggers", () => {
    const noteAutomation = (trigger: string, conditions: unknown[] = []) =>
      makeAutomation(t.adminA, {
        name: `on ${trigger}`,
        trigger,
        conditions,
        actions: [{ type: "create_customer_note", input: { content: "fired" } }],
      });
    const firedNotes = async () => (await db()).customerNote.count({ where: { content: "fired" } });

    it("customer.created", async () => {
      const a = await noteAutomation("customer.created");
      await createCustomer(
        await ctxOf(t.memberA),
        createCustomerSchema.parse({ firstName: "Zed" }),
      );
      await queue.drain();
      expect((await executions(a.id))[0]).toMatchObject({
        status: "COMPLETED",
        eventType: "customer.created",
      });
      expect(await firedNotes()).toBe(1);
    });

    it("customer.updated (only when something changed) with a changedFields condition", async () => {
      const a = await noteAutomation("customer.updated", [
        { field: "changedFields", operator: "contains", value: "company" },
      ]);
      const ctx = await ctxOf(t.memberA);
      await updateCustomer(ctx, t.customerA.id, updateCustomerSchema.parse({ company: "Acme" })); // no change
      await updateCustomer(ctx, t.customerA.id, updateCustomerSchema.parse({ jobTitle: "CTO" })); // other field
      await updateCustomer(ctx, t.customerA.id, updateCustomerSchema.parse({ company: "NewCo" }));
      await queue.drain();
      expect(await executions(a.id)).toHaveLength(1);
      expect(await firedNotes()).toBe(1);
    });

    it("conversation.created", async () => {
      const a = await noteAutomation("conversation.created");
      await createConversation(
        await ctxOf(t.memberA),
        createConversationSchema.parse({ customerId: t.customerA.id, subject: "Hello" }),
      );
      await queue.drain();
      expect((await executions(a.id))[0]).toMatchObject({ status: "COMPLETED" });
    });

    it("conversation.status_changed", async () => {
      const a = await noteAutomation("conversation.status_changed", [
        { field: "status", operator: "equals", value: "PENDING" },
        { field: "previousStatus", operator: "equals", value: "OPEN" },
      ]);
      const conversation = await newConversation();
      await updateConversation(await ctxOf(t.memberA), conversation.id, { status: "PENDING" });
      await queue.drain();
      expect(await executions(a.id)).toHaveLength(1);
    });

    it("conversation.assigned", async () => {
      const a = await noteAutomation("conversation.assigned", [
        { field: "assignee", operator: "equals", value: t.memberA.id },
      ]);
      const conversation = await newConversation();
      await assignConversation(await ctxOf(t.adminA), conversation.id, t.otherMemberA.id);
      await assignConversation(await ctxOf(t.adminA), conversation.id, t.memberA.id);
      await queue.drain();
      expect(await executions(a.id)).toHaveLength(1);
    });

    it("message.created matches on message text but never stores the text", async () => {
      const a = await noteAutomation("message.created", [
        { field: "senderType", operator: "equals", value: "CUSTOMER" },
        { field: "body", operator: "contains", value: "refund" },
      ]);
      const conversation = await newConversation();
      const ctx = await ctxOf(t.memberA);
      await sendMessage(ctx, conversation.id, {
        body: "Hello there",
        type: "MESSAGE",
        from: "CUSTOMER",
      });
      await sendMessage(ctx, conversation.id, {
        body: "I want a REFUND",
        type: "MESSAGE",
        from: "USER",
      });
      await sendMessage(ctx, conversation.id, {
        body: "I want a REFUND",
        type: "MESSAGE",
        from: "CUSTOMER",
      });
      await queue.drain();
      const runs = await executions(a.id);
      expect(runs).toHaveLength(1);
      expect(JSON.stringify(runs[0])).not.toMatch(/want a/i); // the message text itself
      expect(runs[0].eventData).not.toHaveProperty("body");
      expect(
        (runs[0].conditionResults as { field: string }[]).find((c) => c.field === "body"),
      ).not.toHaveProperty("actual");
    });

    it("customer.tag_added and customer.tag_removed", async () => {
      const added = await noteAutomation("customer.tag_added", [
        { field: "tagName", operator: "equals", value: "vip" },
      ]);
      const removed = await noteAutomation("customer.tag_removed");
      const ctx = await ctxOf(t.memberA);
      const tag = await addTagToCustomer(ctx, t.customerA.id, { name: "vip" });
      await queue.drain();
      expect(await executions(added.id)).toHaveLength(1);
      expect(await executions(removed.id)).toHaveLength(0);
      await removeTagFromCustomer(await ctxOf(t.memberA), t.customerA.id, tag.id);
      await queue.drain();
      expect(await executions(removed.id)).toHaveLength(1);
    });

    it("events from a failed transaction are never emitted", async () => {
      const a = await noteAutomation("conversation.status_changed");
      const conversation = await newConversation({ status: "RESOLVED" });
      await expect(
        updateConversation(await ctxOf(t.memberA), conversation.id, { status: "PENDING" }),
      ).rejects.toMatchObject({ status: 409 });
      await queue.drain();
      expect(await executions(a.id)).toHaveLength(0);
    });

    it("a no-op update emits nothing", async () => {
      const a = await noteAutomation("conversation.priority_changed");
      const conversation = await newConversation({ priority: "NORMAL" });
      await updateConversation(await ctxOf(t.memberA), conversation.id, { priority: "NORMAL" });
      await queue.drain();
      expect(await executions(a.id)).toHaveLength(0);
    });

    it("changes made by an automation do not start automations (no loops)", async () => {
      const a = await makeAutomation(t.adminA, {
        name: "Loop",
        trigger: "conversation.priority_changed",
        conditions: [],
        actions: [{ type: "change_conversation_priority", input: { priority: "LOW" } }],
      });
      const conversation = await newConversation();
      await setPriority(conversation.id, "URGENT");
      expect(await executions(a.id)).toHaveLength(1); // not 2, not unbounded
      expect((await conversationRow(conversation.id)).priority).toBe("LOW");
    });

    it("automations never fire across organizations", async () => {
      as(t.ownerB);
      const ownerBCtx = await requireOrganizationContext();
      const foreign = await createAutomation(
        ownerBCtx,
        automationInputSchema.parse({
          name: "B rule",
          trigger: "conversation.priority_changed",
          conditions: [],
          actions: [{ type: "create_customer_note", input: { content: "fired" } }],
        }),
      );
      const conversation = await newConversation();
      await setPriority(conversation.id, "URGENT");
      expect(await executions(foreign.id)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("worker: failures, retries and concurrency", () => {
    async function queuedRun(definition = urgentRouting()) {
      const automation = await makeAutomation(t.adminA, definition);
      const conversation = await newConversation();
      const idle = new MemoryAutomationQueue({ backoffBaseMs: 0 });
      setAutomationQueueForTesting(idle);
      await ensureInlineWorker(async () => undefined);
      await updateConversation(await ctxOf(t.memberA), conversation.id, { priority: "URGENT" });
      const [execution] = await executions(automation.id);
      return {
        automation,
        conversation,
        execution,
        job: { executionId: execution.id, organizationId: t.orgA.id },
      };
    }
    const attempt = { attempt: 1, maxAttempts: 5 };

    it("a failing action records an actionable error, keeps earlier results and is not retried", async () => {
      const automation = await makeAutomation();
      // The assignee leaves the organization after the automation was saved.
      await (
        await db()
      ).membership.deleteMany({
        where: { userId: t.memberA.id, organizationId: t.orgA.id },
      });
      const conversation = await newConversation();
      await setPriority(conversation.id, "URGENT", t.adminA);

      const [run] = await executions(automation.id);
      expect(run).toMatchObject({ status: "FAILED", errorCode: "NOT_FOUND", attempts: 1 });
      expect(run.errorMessage).toMatch(/not found/i);
      const results = run.actionResults as {
        action: string;
        status: string;
        error?: { code: string };
      }[];
      expect(results.map((r) => [r.action, r.status])).toEqual([
        ["add_customer_tag", "completed"],
        ["assign_conversation", "failed"],
      ]);
      expect(results[1].error?.code).toBe("NOT_FOUND");
      expect((await conversationRow(conversation.id)).assignedToUserId).toBeNull();
    });

    it("transient errors are retried with the SAME execution; completed actions never run twice", async () => {
      const automation = await makeAutomation(t.adminA, {
        name: "Flaky",
        trigger: "conversation.priority_changed",
        conditions: [],
        actions: [
          { type: "add_customer_tag", input: { tag: "once" } },
          { type: "create_customer_note", input: { content: "flaky" } },
        ],
      });
      let noteCalls = 0;
      const registry = createActionRegistry({
        create_customer_note: async () => {
          noteCalls++;
          if (noteCalls < 3) throw new Error("connection reset by peer"); // raw detail must never be stored
          return {};
        },
      });
      const retryQueue = new MemoryAutomationQueue({ backoffBaseMs: 0, maxAttempts: 5 });
      setAutomationQueueForTesting(retryQueue);
      await ensureInlineWorker((job, a) => processAutomationJob(job, a, { actions: registry }));
      const tagSpy = vi.spyOn(registry.get("add_customer_tag")!, "execute");

      const conversation = await newConversation();
      await updateConversation(await ctxOf(t.memberA), conversation.id, { priority: "HIGH" });
      await retryQueue.drain();

      const [run] = await executions(automation.id);
      expect(run).toMatchObject({ status: "COMPLETED", attempts: 3, errorCode: null });
      expect(noteCalls).toBe(3);
      // The tag action ran once in total, although the run took 3 attempts.
      expect(tagSpy).toHaveBeenCalledTimes(1);
      expect(await tagsOf()).toHaveLength(1);
    });

    it("gives up after the bounded number of attempts and stores only a safe error", async () => {
      const automation = await makeAutomation(t.adminA, {
        name: "Always failing",
        trigger: "conversation.priority_changed",
        conditions: [],
        actions: [{ type: "create_customer_note", input: { content: "x" } }],
      });
      let calls = 0;
      const registry = createActionRegistry({
        create_customer_note: async () => {
          calls++;
          throw new Error("password=hunter2 connection refused");
        },
      });
      const retryQueue = new MemoryAutomationQueue({ backoffBaseMs: 0, maxAttempts: 4 });
      setAutomationQueueForTesting(retryQueue);
      await ensureInlineWorker((job, a) => processAutomationJob(job, a, { actions: registry }));

      await updateConversation(await ctxOf(t.memberA), (await newConversation()).id, {
        priority: "HIGH",
      });
      await retryQueue.drain();

      const [run] = await executions(automation.id);
      expect(calls).toBe(4);
      expect(run).toMatchObject({ status: "FAILED", errorCode: "EXECUTION_ERROR", attempts: 4 });
      expect(JSON.stringify(run)).not.toMatch(/hunter2|connection refused/);
    });

    it("two workers racing for one execution run it exactly once", async () => {
      const { job, conversation } = await queuedRun(
        urgentRouting({
          actions: [{ type: "create_customer_note", input: { content: "once" } }],
        }),
      );
      await Promise.all([
        processAutomationJob(job, attempt),
        processAutomationJob(job, attempt),
        processAutomationJob(job, attempt),
      ]);
      expect(await (await db()).customerNote.count({ where: { content: "once" } })).toBe(1);
      const run = await automationExecutionsRepository.findById(t.orgA.id, job.executionId);
      expect(run).toMatchObject({ status: "COMPLETED", attempts: 1 });
      expect(conversation.id).toBeTruthy();
    });

    it("a finished execution is never run again, even if the job is delivered again", async () => {
      const { job } = await queuedRun();
      await processAutomationJob(job, attempt);
      await processAutomationJob(job, attempt);
      await processAutomationJob(job, { attempt: 2, maxAttempts: 5 });
      expect(await tagsOf()).toHaveLength(1);
      const run = await automationExecutionsRepository.findById(t.orgA.id, job.executionId);
      expect(run).toMatchObject({ status: "COMPLETED", attempts: 1 });
    });

    it("takes over a run whose worker crashed (stale lock) without repeating finished actions", async () => {
      const { job, execution } = await queuedRun();
      await (
        await db()
      ).automationExecution.update({
        where: { id: execution.id },
        data: {
          status: "RUNNING",
          attempts: 1,
          lockedAt: new Date(Date.now() - 10 * 60_000),
          actionResults: [
            {
              index: 0,
              action: "add_customer_tag",
              status: "completed",
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            },
          ],
        },
      });
      await processAutomationJob(job, { attempt: 2, maxAttempts: 5 });
      const run = await automationExecutionsRepository.findById(t.orgA.id, job.executionId);
      expect(run).toMatchObject({ status: "COMPLETED", attempts: 2 });
      expect(await tagsOf()).toHaveLength(0); // action 0 was recorded as done, so it was skipped
    });

    it("a run that is RUNNING with a fresh lock is left alone", async () => {
      const { job, execution } = await queuedRun();
      await (
        await db()
      ).automationExecution.update({
        where: { id: execution.id },
        data: { status: "RUNNING", lockedAt: new Date() },
      });
      await processAutomationJob(job, attempt);
      expect(await tagsOf()).toHaveLength(0);
    });

    it("the automation creator's CURRENT role is enforced when it runs", async () => {
      const automation = await makeAutomation(); // admin creates: tag + assign
      await (
        await db()
      ).membership.updateMany({
        where: { userId: t.adminA.id, organizationId: t.orgA.id },
        data: { role: "MEMBER" },
      });
      const conversation = await newConversation();
      await setPriority(conversation.id, "URGENT", t.ownerA);

      const [run] = await executions(automation.id);
      expect(run).toMatchObject({ status: "FAILED", errorCode: "FORBIDDEN" });
      expect((await tagsOf()).map((l) => l.tag.name)).toEqual(["urgent"]); // tag_customers: still allowed
      expect((await conversationRow(conversation.id)).assignedToUserId).toBeNull(); // assign: admin only
    });

    it("a creator who left the organization can no longer run anything", async () => {
      const automation = await makeAutomation();
      await (
        await db()
      ).membership.deleteMany({
        where: { userId: t.adminA.id, organizationId: t.orgA.id },
      });
      const conversation = await newConversation();
      await setPriority(conversation.id, "URGENT", t.ownerA);
      const [run] = await executions(automation.id);
      expect(run).toMatchObject({ status: "FAILED", errorCode: "FORBIDDEN" });
      expect(await tagsOf()).toHaveLength(0);
    });

    it("an unreachable queue is recorded as a visible failure, not lost", async () => {
      const broken = new MemoryAutomationQueue();
      vi.spyOn(broken, "enqueue").mockRejectedValue(new Error("ECONNREFUSED 127.0.0.1:6379"));
      setAutomationQueueForTesting(broken);
      await ensureInlineWorker(async () => undefined);
      const automation = await makeAutomation();
      const conversation = await newConversation();
      await updateConversation(await ctxOf(t.memberA), conversation.id, { priority: "URGENT" });
      const [run] = await executions(automation.id);
      expect(run).toMatchObject({ status: "FAILED", errorCode: "QUEUE_UNAVAILABLE" });
      expect(run.errorMessage).not.toMatch(/ECONNREFUSED/);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("API: CRUD, validation and RBAC", () => {
    const body = () => urgentRouting();

    it("full lifecycle through the API", async () => {
      as(t.adminA);
      const created = await call(createRoute, { method: "POST", body: body() });
      expect(created.status).toBe(201);
      const id = created.body.automation.id as string;
      expect(created.body.automation).toMatchObject({
        name: "Urgent conversation routing",
        enabled: true,
        trigger: "conversation.priority_changed",
      });

      expect((await call(listRoute)).body.items).toHaveLength(1);
      expect((await call(getRoute, { params: { automationId: id } })).body.automation.id).toBe(id);

      const patched = await call(patchRoute, {
        method: "PATCH",
        params: { automationId: id },
        body: { name: "Renamed", conditions: [] },
      });
      expect(patched.status).toBe(200);
      expect(patched.body.automation).toMatchObject({ name: "Renamed", conditions: [] });

      const disabled = await call(disableRoute, { method: "POST", params: { automationId: id } });
      expect(disabled.body.automation.enabled).toBe(false);
      const enabled = await call(enableRoute, { method: "POST", params: { automationId: id } });
      expect(enabled.body.automation.enabled).toBe(true);

      expect((await call(executionsRoute, { params: { automationId: id } })).body.items).toEqual(
        [],
      );

      const removed = await call(deleteRoute, { method: "DELETE", params: { automationId: id } });
      expect(removed.status).toBe(204);
      expect((await call(getRoute, { params: { automationId: id } })).status).toBe(404);
    });

    it("returns structured validation errors", async () => {
      as(t.adminA);
      const res = await call(createRoute, {
        method: "POST",
        body: {
          ...body(),
          conditions: [{ field: "nope", operator: "equals", value: "x" }],
          actions: [{ type: "assign_conversation", input: { assigneeId: "bad" } }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
      expect(res.body.error.details.problems.join(" ")).toMatch(/nope/);
      expect(res.body.error.details.problems.join(" ")).toMatch(/assigneeId/);

      for (const bad of [
        { ...body(), trigger: "conversation.deleted" },
        { ...body(), actions: [] },
        { ...body(), actions: [{ type: "delete_everything", input: {} }] },
        { ...body(), name: "" },
      ]) {
        expect((await call(createRoute, { method: "POST", body: bad })).status).toBe(400);
      }
      expect((await call(createRoute, { method: "POST", rawBody: "{oops" })).status).toBe(400);
    });

    it("a fake organizationId (or createdBy) in the body is rejected, never honored", async () => {
      as(t.adminA);
      for (const extra of [
        { organizationId: t.orgB.id },
        { createdByUserId: t.ownerB.id },
        { id: randomUUID() },
      ]) {
        const res = await call(createRoute, { method: "POST", body: { ...body(), ...extra } });
        expect(res.status).toBe(400);
      }
      expect(await (await db()).automation.count()).toBe(0);
      // And the organization of a valid create always comes from the session.
      as(t.adminA);
      const ok = await call(createRoute, { method: "POST", body: body() });
      const row = await (
        await db()
      ).automation.findUniqueOrThrow({ where: { id: ok.body.automation.id } });
      expect(row).toMatchObject({ organizationId: t.orgA.id, createdByUserId: t.adminA.id });
    });

    it("members can view automations but cannot create, change, enable or delete them", async () => {
      const automation = await makeAutomation();
      const params = { automationId: automation.id };
      as(t.memberA);
      expect((await call(listRoute)).status).toBe(200);
      expect((await call(getRoute, { params })).status).toBe(200);
      expect((await call(executionsRoute, { params })).status).toBe(200);
      expect((await call(createRoute, { method: "POST", body: body() })).status).toBe(403);
      expect(
        (await call(patchRoute, { method: "PATCH", params, body: { name: "x" } })).status,
      ).toBe(403);
      expect((await call(disableRoute, { method: "POST", params })).status).toBe(403);
      expect((await call(enableRoute, { method: "POST", params })).status).toBe(403);
      expect((await call(deleteRoute, { method: "DELETE", params })).status).toBe(403);
      expect(
        (await call(testRoute, { method: "POST", params, body: { data: { priority: "URGENT" } } }))
          .status,
      ).toBe(403);
      expect(
        (await (await db()).automation.findUniqueOrThrow({ where: { id: automation.id } })).enabled,
      ).toBe(true);
    });

    it("requires authentication", async () => {
      const automation = await makeAutomation();
      signOut();
      expect((await call(listRoute)).status).toBe(401);
      expect((await call(createRoute, { method: "POST", body: body() })).status).toBe(401);
      expect((await call(getRoute, { params: { automationId: automation.id } })).status).toBe(401);
    });

    it("an assignee from another organization cannot be referenced", async () => {
      as(t.adminA);
      const res = await call(createRoute, {
        method: "POST",
        body: urgentRouting({
          actions: [{ type: "assign_conversation", input: { assigneeId: t.ownerB.id } }],
        }),
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.problems.join(" ")).toMatch(/not a member/);
    });

    it("another organization's automation behaves like it does not exist", async () => {
      const automation = await makeAutomation();
      const params = { automationId: automation.id };
      as(t.ownerB);
      expect((await call(listRoute)).body.items).toEqual([]);
      for (const res of [
        await call(getRoute, { params }),
        await call(patchRoute, { method: "PATCH", params, body: { name: "x" } }),
        await call(deleteRoute, { method: "DELETE", params }),
        await call(enableRoute, { method: "POST", params }),
        await call(disableRoute, { method: "POST", params }),
        await call(executionsRoute, { params }),
        await call(testRoute, { method: "POST", params, body: { data: {} } }),
        await call(executionRoute, { params: { ...params, executionId: randomUUID() } }),
      ]) {
        expect(res.status).toBe(404);
      }
      expect(
        (await (await db()).automation.findUniqueOrThrow({ where: { id: automation.id } })).name,
      ).toBe("Urgent conversation routing");
    });

    it("executions list and detail are scoped to the automation and organization", async () => {
      const automation = await makeAutomation();
      const other = await makeAutomation(t.adminA, urgentRouting({ name: "Other" }));
      await setPriority((await newConversation()).id, "URGENT");
      const [run] = await executions(automation.id);

      as(t.memberA);
      const list = await call(executionsRoute, { params: { automationId: automation.id } });
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: run.id, status: "COMPLETED" });
      const detail = await call(executionRoute, {
        params: { automationId: automation.id, executionId: run.id },
      });
      expect(detail.body.execution.actionResults).toHaveLength(2);
      // Same execution id under a different automation is not found.
      expect(
        (await call(executionRoute, { params: { automationId: other.id, executionId: run.id } }))
          .status,
      ).toBe(404);
      as(t.ownerB);
      expect(
        (
          await call(executionRoute, {
            params: { automationId: automation.id, executionId: run.id },
          })
        ).status,
      ).toBe(404);
    });

    it("the dry-run test endpoint executes nothing and reports what would happen", async () => {
      const automation = await makeAutomation();
      as(t.adminA);
      const res = await call(testRoute, {
        method: "POST",
        params: { automationId: automation.id },
        body: { data: { priority: "URGENT", status: "OPEN" } },
      });
      expect(res.status).toBe(200);
      expect(res.body.wouldRun).toBe(true);
      expect(
        res.body.actions.map((a: { type: string; permitted: boolean }) => [a.type, a.permitted]),
      ).toEqual([
        ["add_customer_tag", true],
        ["assign_conversation", true],
      ]);
      const no = await call(testRoute, {
        method: "POST",
        params: { automationId: automation.id },
        body: { data: { priority: "LOW" } },
      });
      expect(no.body.wouldRun).toBe(false);
      expect(await executions()).toHaveLength(0);
      expect(await tagsOf()).toHaveLength(0);
      // Unknown sample fields are refused.
      expect(
        (
          await call(testRoute, {
            method: "POST",
            params: { automationId: automation.id },
            body: { data: { organizationId: "x" } },
          })
        ).status,
      ).toBe(400);
    });
  });

  // -------------------------------------------------------------------------------------------
  describe("run history data: previous values and member names", () => {
    const memberAssignment = (assigneeId: string) =>
      urgentRouting({
        name: "Assign on assignment",
        trigger: "conversation.assigned",
        conditions: [{ field: "assignee", operator: "equals", value: assigneeId }],
        actions: [{ type: "assign_conversation", input: { assigneeId: t.otherMemberA.id } }],
      });
    const detailOf = async (automationId: string, user = t.memberA) => {
      const [run] = await executions(automationId);
      as(user);
      const res = await call(executionRoute, { params: { automationId, executionId: run.id } });
      return { run, res };
    };

    it.each([
      ["NORMAL", "NORMAL"],
      ["HIGH", "HIGH"],
      ["LOW", "LOW"],
    ])(
      "stores the real previous priority (%s) next to the evaluated new value: persistence is correct",
      async (previous) => {
        const automation = await makeAutomation();
        const conversation = await newConversation({
          priority: previous as "LOW" | "NORMAL" | "HIGH",
        });
        await setPriority(conversation.id, "URGENT");

        const [run] = await executions(automation.id);
        expect(run.eventData).toMatchObject({ priority: "URGENT", previousPriority: previous });
        // The condition result holds the value of the evaluated field, i.e. the NEW priority.
        expect(run.conditionResults).toEqual([
          {
            field: "priority",
            operator: "equals",
            expected: "URGENT",
            actual: "URGENT",
            passed: true,
          },
        ]);
      },
    );

    it("an update that does not change the priority produces no event, so URGENT -> URGENT cannot occur", async () => {
      const automation = await makeAutomation();
      const conversation = await newConversation({ priority: "URGENT" });
      await setPriority(conversation.id, "URGENT");
      expect(await executions(automation.id)).toHaveLength(0);
    });

    it("keeps member ids as ids in the definition, event data and results; the API adds names beside them", async () => {
      const automation = await makeAutomation(t.adminA, memberAssignment(t.memberA.id));
      const conversation = await newConversation();
      await assignConversation(await ctxOf(t.adminA), conversation.id, t.memberA.id);
      await queue.drain();

      const { run, res } = await detailOf(automation.id);
      // Stored: ids only.
      expect(run.eventData).toMatchObject({ assignee: t.memberA.id });
      expect(run.definition).toMatchObject({
        actions: [{ type: "assign_conversation", input: { assigneeId: t.otherMemberA.id } }],
      });
      expect(JSON.stringify(run)).not.toContain("membera@example.com");
      // API: the same ids, plus a name for each referenced member of THIS organization.
      expect(res.status).toBe(200);
      expect(res.body.execution.eventData.assignee).toBe(t.memberA.id);
      expect(res.body.execution.definition.actions[0].input.assigneeId).toBe(t.otherMemberA.id);
      expect(res.body.execution.memberNames).toEqual({
        [t.memberA.id]: "membera",
        [t.otherMemberA.id]: "othermembera",
      });
    });

    it("never resolves a member of another organization", async () => {
      const automation = await makeAutomation(t.adminA, memberAssignment(t.memberA.id));
      // A run whose data (wrongly or maliciously) mentions organization B's owner.
      const run = await automationExecutionsRepository.createIfAbsent(t.orgA.id, {
        automationId: automation.id,
        eventId: randomUUID(),
        eventType: "conversation.assigned",
        eventData: { assignee: t.ownerB.id, previousAssignee: t.memberA.id },
        definition: {
          name: "x",
          trigger: "conversation.assigned",
          conditions: [],
          actions: [{ type: "assign_conversation", input: { assigneeId: t.ownerB.id } }],
        },
        conditionResults: [],
      });
      as(t.memberA);
      const res = await call(executionRoute, {
        params: { automationId: automation.id, executionId: run!.id },
      });
      expect(res.status).toBe(200);
      expect(res.body.execution.memberNames).toEqual({ [t.memberA.id]: "membera" });
      expect(JSON.stringify(res.body)).not.toMatch(/ownerb/i);
    });

    it("a member who has left simply has no name (no error), and the id is still stored", async () => {
      const automation = await makeAutomation(t.adminA, memberAssignment(t.memberA.id));
      const conversation = await newConversation();
      await assignConversation(await ctxOf(t.adminA), conversation.id, t.memberA.id);
      await queue.drain();
      await (
        await db()
      ).membership.deleteMany({
        where: { userId: t.memberA.id, organizationId: t.orgA.id },
      });

      const { run, res } = await detailOf(automation.id, t.adminA);
      expect(res.status).toBe(200);
      expect(res.body.execution.memberNames).toEqual({ [t.otherMemberA.id]: "othermembera" });
      expect(res.body.execution.memberNames).not.toHaveProperty(t.memberA.id);
      expect(run.eventData).toMatchObject({ assignee: t.memberA.id });
    });

    it("resolves all referenced members with ONE query, however many there are (no N+1)", async () => {
      const automation = await makeAutomation(t.adminA, memberAssignment(t.memberA.id));
      const run = await automationExecutionsRepository.createIfAbsent(t.orgA.id, {
        automationId: automation.id,
        eventId: randomUUID(),
        eventType: "conversation.assigned",
        eventData: { assignee: t.memberA.id, previousAssignee: t.adminA.id },
        definition: {
          name: "x",
          trigger: "conversation.assigned",
          conditions: [],
          actions: [
            { type: "assign_conversation", input: { assigneeId: t.otherMemberA.id } },
            { type: "assign_conversation", input: { assigneeId: t.ownerA.id } },
          ],
        },
        conditionResults: [
          {
            field: "assignee",
            operator: "equals",
            expected: t.memberA.id,
            actual: t.memberA.id,
            passed: true,
          },
        ],
      });
      const batched = vi.spyOn(membershipsRepository, "listByUserIds");
      const single = vi.spyOn(membershipsRepository, "findMember");
      const all = vi.spyOn(membershipsRepository, "listMembers");

      const detail = await getExecution(await ctxOf(t.memberA), automation.id, run!.id);

      expect(batched).toHaveBeenCalledTimes(1);
      expect(batched.mock.calls[0][1].sort()).toEqual(
        [t.memberA.id, t.adminA.id, t.otherMemberA.id, t.ownerA.id].sort(),
      );
      expect(single).not.toHaveBeenCalled();
      expect(all).not.toHaveBeenCalled();
      expect(Object.keys(detail.memberNames)).toHaveLength(4);
    });

    it("a run that mentions no members does no member lookup at all", async () => {
      const automation = await makeAutomation();
      await setPriority((await newConversation()).id, "URGENT");
      const batched = vi.spyOn(membershipsRepository, "listByUserIds");
      const [run] = await executions(automation.id);
      const detail = await getExecution(await ctxOf(t.memberA), automation.id, run.id);
      // The urgent-routing run mentions only its configured assignee: still a single query.
      expect(batched).toHaveBeenCalledTimes(1);
      expect(detail.memberNames).toEqual({ [t.memberA.id]: "membera" });
    });
  });
});
