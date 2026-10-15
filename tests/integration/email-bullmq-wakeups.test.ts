import { Queue, Worker } from "bullmq";
import IORedis from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireOrganizationContext } from "@/server/auth/context";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { BullMqAutomationQueue } from "@/server/automation/queue/bullmq";
import {
  BACKOFF_BASE_MS,
  MAX_ATTEMPTS,
  QUEUE_NAME,
  type AutomationJob,
  type EmailSendJob,
} from "@/server/automation/queue/types";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider, sendingCapabilities } from "@/server/email/fake-provider";
import { createOutboundReply, reconcileOutboundEmail, wakeUp } from "@/server/email/outbound";
import { processQueueJob } from "@/server/jobs";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { disconnectDatabase, resetDatabase, TEST_DATABASE_URL } from "../helpers/db";
import { RecordingQueue } from "../helpers/recording-queue";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

/**
 * REAL Redis and the REAL installed BullMQ (not a queue double). Skipped unless TEST_REDIS_URL points at a THROWAWAY Redis
 * database 15 (every test flushes it), exactly like `automation-bullmq.test.ts`. Tests in the first block exercise BullMQ
 * and the queue driver only; the second block runs the whole path (database outbox, wake-up, real worker, fake provider).
 * Test doubles for the queue (`RecordingQueue`, `MemoryAutomationQueue`) live in other files and are NOT what proves this.
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

const emailJob = (id: string): EmailSendJob => ({
  kind: "email-send",
  executionId: id,
  organizationId: "org",
  sendId: "send",
});

maybe("BullMQ job-id deduplication of email wake-ups (real Redis, real BullMQ)", () => {
  let redis: IORedis;
  const closers: (() => Promise<unknown>)[] = [];

  beforeEach(async () => {
    redis = new IORedis(redisUrl!);
    await redis.flushdb();
  });
  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) await close();
    await redis.quit();
  });

  describe("the reported problem, reproduced with BullMQ itself", () => {
    it("with the queue's DEFAULT retention a completed job keeps its id, so a later add with the same id is silently ignored", async () => {
      const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
      closers.push(async () => connection.disconnect());
      // The options the platform's queue uses for every job (see bullmq.ts `defaultJobOptions`).
      const queue = new Queue(QUEUE_NAME, {
        connection,
        defaultJobOptions: {
          attempts: MAX_ATTEMPTS,
          backoff: { type: "exponential", delay: BACKOFF_BASE_MS },
          removeOnComplete: { age: 3600, count: 1000 },
          removeOnFail: { age: 7 * 24 * 3600 },
        },
      });
      closers.push(() => queue.close());
      const seen: string[] = [];
      const worker = new Worker(QUEUE_NAME, async (job) => void seen.push(job.id!), {
        connection,
      });
      closers.push(() => worker.close());
      await worker.waitUntilReady();

      await queue.add("run", emailJob("email-send-X-0"), { jobId: "email-send-X-0" });
      await until(() => seen.length === 1);
      // The job has completed ("not due", "provider unavailable"...). A later wake-up for the same id is a no-op.
      await queue.add("run", emailJob("email-send-X-0"), { jobId: "email-send-X-0" });
      await wait(700);
      expect(seen).toEqual(["email-send-X-0"]); // the second wake-up never reached the worker
      expect(await queue.getJobCounts("completed")).toMatchObject({ completed: 1 });
    });
  });

  describe("the platform's queue driver", () => {
    let queue: BullMqAutomationQueue;
    beforeEach(() => {
      queue = new BullMqAutomationQueue(redisUrl!);
      closers.push(() => queue.close());
    });

    it("accepts a later wake-up with the same id once the earlier job has finished (the fix)", async () => {
      const handler = vi.fn(async () => undefined); // completes without doing anything, like a skipped send
      closers.push((await queue.startWorker(handler)).close);
      await queue.enqueue(emailJob("email-send-X-0"));
      await until(() => handler.mock.calls.length === 1);
      await queue.enqueue(emailJob("email-send-X-0"));
      await until(() => handler.mock.calls.length === 2);
    });

    it("keeps no finished email job behind (bounded Redis usage), whether it completed or failed", async () => {
      let calls = 0;
      closers.push(
        (
          await queue.startWorker(async () => {
            calls++;
            if (calls === 2) throw new Error("boom");
          })
        ).close,
      );
      await queue.enqueue(emailJob("ok"));
      await until(() => calls === 1);
      await wait(300);
      const probe = new Queue(QUEUE_NAME, { connection: redis });
      closers.push(() => probe.close());
      expect(await probe.getJobCounts("completed", "failed")).toEqual({ completed: 0, failed: 0 });
    });

    it("still deduplicates wake-ups that are waiting: many identical wake-ups run once", async () => {
      const handler = vi.fn(async () => undefined);
      await Promise.all(Array.from({ length: 6 }, () => queue.enqueue(emailJob("email-send-Y-0"))));
      closers.push((await queue.startWorker(handler)).close);
      await until(() => handler.mock.calls.length >= 1);
      await wait(500);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("a wake-up that arrives while the same id is RUNNING is dropped (bounded: the maintenance pass re-queues it)", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const handler = vi.fn(async () => gate);
      closers.push((await queue.startWorker(handler)).close);
      await queue.enqueue(emailJob("email-send-Z-0"));
      await until(() => handler.mock.calls.length === 1);
      await queue.enqueue(emailJob("email-send-Z-0")); // same id, first still running
      release();
      await wait(600);
      expect(handler).toHaveBeenCalledTimes(1);
      // ...and once it finished, the next wake-up (the following maintenance pass) is accepted.
      await queue.enqueue(emailJob("email-send-Z-0"));
      await until(() => handler.mock.calls.length === 2);
    });

    it("does not change the deduplication of automation and customer-AI jobs (retained ids still suppress repeats)", async () => {
      const handler = vi.fn(async () => undefined);
      closers.push((await queue.startWorker(handler)).close);
      const automation: AutomationJob = { executionId: "automation-1", organizationId: "org" };
      await queue.enqueue(automation);
      await until(() => handler.mock.calls.length === 1);
      await queue.enqueue(automation);
      await wait(600);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });
});

maybe(
  "outbound email wake-ups through real BullMQ and the real handler (real Redis, real PostgreSQL)",
  () => {
    const DOMAIN = "mail.platform.test";
    let t: Awaited<ReturnType<typeof setupTenants>>;
    let provider: FakeEmailProvider;
    let queue: BullMqAutomationQueue;
    let redis: IORedis;
    let conversationId: string;
    const closers: (() => Promise<unknown>)[] = [];
    const db = async () => (await import("@/db/client")).getDb();
    const row = async (id: string) =>
      (await db()).outboundEmail.findUniqueOrThrow({ where: { id } });

    /** A reply recorded while a recording double stands in for the queue, so the real worker starts from a clean slate. */
    async function recordedReply() {
      const recording = new RecordingQueue();
      setAutomationQueueForTesting(recording);
      as(t.adminA);
      const reply = await createOutboundReply(await requireOrganizationContext(), conversationId, {
        body: "Your order shipped today.",
        clientMessageId: crypto.randomUUID(),
      });
      expect(recording.jobs).toHaveLength(1);
      setAutomationQueueForTesting(queue);
      return reply.sendId;
    }

    beforeEach(async () => {
      vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
      vi.stubEnv("EMAIL_PROVIDER", "fake");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      redis = new IORedis(redisUrl!);
      await redis.flushdb();
      await resetDatabase();
      t = await setupTenants();
      provider = new FakeEmailProvider("bull-secret");
      setEmailProviderForTesting(provider);
      queue = new BullMqAutomationQueue(redisUrl!);
      closers.push(() => queue.close());
      await emailSettingsRepository.create({
        organizationId: t.orgA.id,
        localPart: "help-a",
        supportAddress: `help-a@${DOMAIN}`,
        fromName: "Acme",
      });
      await emailSettingsRepository.setStatus(t.orgA.id, "ACTIVE", null);
      await emailSettingsRepository.setEnabled(t.orgA.id, true);
      const customer = await seedCustomer(t.orgA.id, {
        firstName: "Eve",
        email: "eve@customer.test",
      });
      conversationId = (
        await (
          await db()
        ).conversation.create({
          data: {
            organizationId: t.orgA.id,
            customerId: customer.id,
            subject: "Order help",
            channel: "EMAIL",
            lastMessageAt: new Date(),
          },
        })
      ).id;
      // The real worker, with the real job router (`processQueueJob` -> `processEmailSendJob`).
      closers.push((await queue.startWorker(processQueueJob)).close);
    });
    afterEach(async () => {
      for (const close of closers.splice(0).reverse()) await close();
      await redis.quit();
      setEmailProviderForTesting(undefined);
      setAutomationQueueForTesting(undefined);
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    afterAll(disconnectDatabase);

    const jobsLeft = async () => {
      const probe = new Queue(QUEUE_NAME, { connection: redis });
      try {
        return await probe.getJobCounts("completed", "failed", "waiting", "active", "delayed");
      } finally {
        await probe.close();
      }
    };

    it("provider_unavailable: a wake-up that found no usable provider does not block the next one with the same id", async () => {
      const sendId = await recordedReply();
      const good = provider.sending;
      provider.sending = sendingCapabilities({ lookupByKey: true, lookupConsistency: "none" }); // refused by the policy
      expect(await wakeUp({ id: sendId, organizationId: t.orgA.id, attempts: 0 })).toBe(true);
      await until(async () => (await jobsLeft()).waiting + (await jobsLeft()).active === 0);
      expect((await row(sendId)).status).toBe("PENDING"); // skipped, not lost
      provider.sending = good;
      // The reconciler's wake-up carries the SAME id (attempts unchanged): it must reach the worker.
      await reconcileOutboundEmail();
      await until(async () => (await row(sendId)).status === "SENT");
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
    });

    it("not_due: a wake-up that arrived too early does not block the one after the retry time", async () => {
      const sendId = await recordedReply();
      const client = await db();
      await client.outboundEmail.update({
        where: { id: sendId },
        data: { nextAttemptAt: new Date(Date.now() + 1500) },
      });
      await wakeUp({ id: sendId, organizationId: t.orgA.id, attempts: 0 });
      await until(async () => (await jobsLeft()).waiting + (await jobsLeft()).active === 0);
      expect(provider.sendCalls).toBe(0);
      await wait(1700); // the retry time passes
      await reconcileOutboundEmail(); // same id again
      await until(async () => (await row(sendId)).status === "SENT");
      expect(provider.sent).toHaveLength(1);
    });

    it("lost_claim: a wake-up that lost the claim race does not block the next one", async () => {
      const sendId = await recordedReply();
      const spy = vi.spyOn(outboundEmailRepository, "claim").mockResolvedValueOnce(null);
      await wakeUp({ id: sendId, organizationId: t.orgA.id, attempts: 0 });
      await until(() => spy.mock.calls.length === 1);
      await until(async () => (await jobsLeft()).waiting + (await jobsLeft()).active === 0);
      expect(provider.sendCalls).toBe(0);
      await reconcileOutboundEmail();
      await until(async () => (await row(sendId)).status === "SENT");
      expect(provider.sent).toHaveLength(1);
    });

    it("many wake-ups for one send (duplicates, the reconciler, concurrent passes) deliver exactly once", async () => {
      const sendId = await recordedReply();
      await Promise.all([
        ...Array.from({ length: 5 }, () =>
          wakeUp({ id: sendId, organizationId: t.orgA.id, attempts: 0 }),
        ),
        reconcileOutboundEmail(),
        reconcileOutboundEmail(),
      ]);
      await until(async () => (await row(sendId)).status === "SENT");
      await reconcileOutboundEmail();
      await wait(600);
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
      const left = await jobsLeft();
      expect(left.completed + left.failed).toBe(0); // nothing accumulates in Redis
    });
  },
);
