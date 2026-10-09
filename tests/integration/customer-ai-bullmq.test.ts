import IORedis from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as conversationsPost } from "@/app/api/widget/conversations/route";
import { POST as sessionPost } from "@/app/api/widget/session/route";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { BullMqAutomationQueue } from "@/server/automation/queue/bullmq";
import { requireOrganizationContext } from "@/server/auth/context";
import { processQueueJob } from "@/server/jobs";
import { MemoryRateLimiter, setRateLimiterForTesting } from "@/server/rate-limit";
import { customerAiJobId } from "@/server/services/customer-ai";
import { getWidgetSettings, updateWidgetSettings } from "@/server/widget/settings";
import { installFakeAi, uninstallFakeAi } from "../helpers/ai";
import { disconnectDatabase, resetDatabase, TEST_DATABASE_URL } from "../helpers/db";
import { REFUND_DOC, createPublishedDocument, setupAiTenants } from "../helpers/knowledge";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

/**
 * Customer-facing AI over the REAL queue: visitor message -> BullMQ (Redis) -> worker ->
 * PostgreSQL. Skipped unless TEST_REDIS_URL points at a throwaway Redis database 15 (it is flushed).
 */
const redisUrl = process.env.TEST_REDIS_URL;
const enabled = Boolean(redisUrl && TEST_DATABASE_URL && /\/15$/.test(redisUrl));
const maybe = enabled ? describe : describe.skip;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => Promise<boolean>, timeoutMs = 20_000) {
  const started = Date.now();
  while (!(await condition())) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await wait(100);
  }
}

type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;
async function widgetCall(handler: unknown, body: unknown, token?: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "9.9.9.9",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await (handler as Handler)(
    new Request("http://localhost/api/widget/test", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({}) as Promise<never> },
  );
  return { status: response.status, body: await response.json() };
}

maybe("customer-facing AI over BullMQ (real Redis + PostgreSQL)", () => {
  let queue: BullMqAutomationQueue;
  let redis: IORedis;
  let worker: { close(): Promise<void> } | undefined;

  beforeEach(async () => {
    redis = new IORedis(redisUrl!);
    await redis.flushdb();
    queue = new BullMqAutomationQueue(redisUrl!);
    setAutomationQueueForTesting(queue);
    setRateLimiterForTesting(new MemoryRateLimiter());
    installFakeAi();
    await resetDatabase();
  });
  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await queue.close();
    await redis.quit();
    setAutomationQueueForTesting(undefined);
    setRateLimiterForTesting(undefined);
    uninstallFakeAi();
  });
  afterAll(disconnectDatabase);

  it("a visitor question is answered by the worker through Redis, exactly once", async () => {
    const t = await setupAiTenants();
    as(t.adminA);
    const ctx = await requireOrganizationContext();
    await createPublishedDocument(ctx, REFUND_DOC);
    const { publicKey } = await getWidgetSettings(ctx);
    await updateWidgetSettings(ctx, {
      enabled: true,
      displayName: "Support",
      welcomeMessage: "Hi",
      accentColor: null,
      allowedOrigins: [],
      aiRepliesEnabled: true,
    });
    worker = await queue.startWorker(processQueueJob);

    const session = await widgetCall(sessionPost, { key: publicKey });
    const created = await widgetCall(
      conversationsPost,
      { body: "What is your refund policy?", clientMessageId: crypto.randomUUID() },
      session.body.token,
    );
    expect(created.status).toBe(201); // returned without waiting for the model
    const conversationId = created.body.conversation.id as string;

    const { getDb } = await import("@/db/client");
    const db = getDb();
    const aiCount = () => db.message.count({ where: { conversationId, senderType: "AI_AGENT" } });
    await until(async () => (await aiCount()) === 1);
    await wait(1000);
    expect(await aiCount()).toBe(1);

    // Re-queueing the same message (duplicate event / retry) is a no-op.
    const visitorMessage = await db.message.findFirstOrThrow({
      where: { conversationId, senderType: "CUSTOMER" },
    });
    const job = {
      kind: "customer-ai" as const,
      executionId: customerAiJobId(visitorMessage.id),
      organizationId: t.orgA.id,
      conversationId,
      messageId: visitorMessage.id,
    };
    await Promise.all([queue.enqueue(job), queue.enqueue(job), queue.enqueue(job)]);
    await wait(1500);
    expect(await aiCount()).toBe(1);
  }, 60_000);
});
