import IORedis from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationInputSchema } from "@/server/automation/definition";
import { ensureInlineWorker, setAutomationQueueForTesting } from "@/server/automation/queue";
import { BullMqAutomationQueue } from "@/server/automation/queue/bullmq";
import { UnrecoverableJobError, type AutomationJob } from "@/server/automation/queue/types";
import { processAutomationJob } from "@/server/automation/runner";
import { requireOrganizationContext } from "@/server/auth/context";
import { createAutomation } from "@/server/services/automations";
import { updateConversation } from "@/server/services/conversations";
import { seedConversation, setupConversationTenants } from "../helpers/conversations";
import { disconnectDatabase, resetDatabase, TEST_DATABASE_URL } from "../helpers/db";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

/**
 * Real Redis + BullMQ. Skipped unless TEST_REDIS_URL points at a THROWAWAY Redis database 15
 * (the test flushes it), e.g. TEST_REDIS_URL=redis://127.0.0.1:6379/15. The ordinary suite never
 * needs Redis.
 */
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = Boolean(redisUrl && TEST_DATABASE_URL && /\/15$/.test(redisUrl));
const maybe = enabled ? describe : describe.skip;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => Promise<boolean> | boolean, timeoutMs = 15_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await wait(50);
  }
}

maybe("BullMQ driver (real Redis)", () => {
  let queue: BullMqAutomationQueue;
  let redis: IORedis;
  const workers: { close(): Promise<void> }[] = [];

  beforeEach(async () => {
    redis = new IORedis(redisUrl!);
    await redis.flushdb();
    queue = new BullMqAutomationQueue(redisUrl!);
  });
  afterEach(async () => {
    for (const worker of workers.splice(0)) await worker.close();
    await queue.close();
    await redis.quit();
  });
  afterAll(disconnectDatabase);

  const job = (id: string): AutomationJob => ({ executionId: id, organizationId: "org" });

  it("delivers a job to the worker with its attempt numbers", async () => {
    const seen: unknown[] = [];
    workers.push(
      await queue.startWorker(async (j, attempt) => {
        seen.push([j.executionId, attempt]);
      }),
    );
    await queue.enqueue(job("e1"));
    await until(() => seen.length === 1);
    expect(seen[0]).toEqual(["e1", { attempt: 1, maxAttempts: 5 }]);
  });

  it("deduplicates by execution id (job id)", async () => {
    const handler = vi.fn(async () => undefined);
    await Promise.all([
      queue.enqueue(job("dup")),
      queue.enqueue(job("dup")),
      queue.enqueue(job("dup")),
    ]);
    workers.push(await queue.startWorker(handler));
    await until(() => handler.mock.calls.length >= 1);
    await wait(500);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("retries a failing job with backoff, and stops on an unrecoverable error", async () => {
    const attempts: number[] = [];
    const permanent = vi.fn(async () => {
      throw new UnrecoverableJobError("permanent");
    });
    workers.push(
      await queue.startWorker(async (j, attempt) => {
        if (j.executionId === "perm") return permanent();
        attempts.push(attempt.attempt);
        if (attempt.attempt < 2) throw new Error("transient");
      }),
    );
    await queue.enqueue(job("flaky"));
    await queue.enqueue(job("perm"));
    await until(() => attempts.length === 2, 20_000); // default backoff: 2s before attempt 2
    await wait(500);
    expect(attempts).toEqual([1, 2]);
    expect(permanent).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("end to end: event -> BullMQ -> worker -> COMPLETED automation execution", async () => {
    await resetDatabase();
    const t = await setupConversationTenants();
    setAutomationQueueForTesting(queue);
    await ensureInlineWorker(async () => undefined); // driver is bullmq: no inline worker
    workers.push(await queue.startWorker(processAutomationJob));

    as(t.adminA);
    await createAutomation(
      await requireOrganizationContext(),
      automationInputSchema.parse({
        name: "Urgent routing",
        trigger: "conversation.priority_changed",
        conditions: [{ field: "priority", operator: "equals", value: "URGENT" }],
        actions: [
          { type: "add_customer_tag", input: { tag: "urgent" } },
          { type: "assign_conversation", input: { assigneeId: t.memberA.id } },
        ],
      }),
    );
    const conversation = await seedConversation(t.orgA.id, t.customerA.id);
    as(t.memberA);
    await updateConversation(await requireOrganizationContext(), conversation.id, {
      priority: "URGENT",
    });

    const { getDb } = await import("@/db/client");
    await until(async () => {
      const run = await getDb().automationExecution.findFirst();
      return run?.status === "COMPLETED";
    });
    expect(
      (await getDb().conversation.findUniqueOrThrow({ where: { id: conversation.id } }))
        .assignedToUserId,
    ).toBe(t.memberA.id);
    expect(await getDb().customerTag.count()).toBe(1);
    setAutomationQueueForTesting(undefined);
  });
});
