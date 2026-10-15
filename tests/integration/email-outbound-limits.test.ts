import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as emailReplyRoute } from "@/app/api/conversations/[conversationId]/email-reply/route";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { createOutboundReply, processEmailSendJob } from "@/server/email/outbound";
import {
  OUTBOUND_LIMIT_CEILINGS,
  OUTBOUND_LIMIT_DEFAULTS,
  enforceOutboundLimits,
  getOutboundLimits,
} from "@/server/email/outbound-limits";
import { RateLimitError } from "@/server/rate-limit";
import { metrics } from "@/server/observability/metrics";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { RecordingQueue } from "../helpers/recording-queue";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const uuid = () => crypto.randomUUID();
const HIGH = "600";

describeDb("outbound email: abuse limits (organization, account, recipient)", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  let queue: RecordingQueue;
  const db = async () => (await import("@/db/client")).getDb();

  /** Environment limits for one test; everything not named stays far out of the way. */
  async function limits(over: Record<string, string> = {}) {
    for (const [key, value] of Object.entries({
      EMAIL_OUTBOUND_ORG_PER_MINUTE: HIGH,
      EMAIL_OUTBOUND_ORG_PER_DAY: "100000",
      EMAIL_OUTBOUND_USER_PER_MINUTE: "120",
      EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "100",
      ...over,
    })) {
      vi.stubEnv(key, value);
    }
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
  }

  async function enableEmail(organizationId: string, name: string) {
    await emailSettingsRepository.create({
      organizationId,
      localPart: name,
      supportAddress: `${name}@${DOMAIN}`,
      fromName: "Support",
    });
    await emailSettingsRepository.setStatus(organizationId, "ACTIVE", null);
    await emailSettingsRepository.setEnabled(organizationId, true);
  }

  async function conversationWith(organizationId: string, email: string, subject = "Help") {
    const customer = await seedCustomer(organizationId, { firstName: "C", email });
    return (
      await (
        await db()
      ).conversation.create({
        data: {
          organizationId,
          customerId: customer.id,
          subject,
          channel: "EMAIL",
          lastMessageAt: new Date(),
        },
      })
    ).id;
  }

  let conversationA: string;
  const reply = async (
    user: Parameters<typeof as>[0],
    cid: string,
    over: { body?: string; clientMessageId?: string } = {},
  ) => {
    as(user);
    return createOutboundReply(await requireOrganizationContext(), cid, {
      body: over.body ?? "Your order shipped today.",
      clientMessageId: over.clientMessageId ?? uuid(),
    });
  };
  const sends = async (organizationId = t.orgA.id) =>
    (await db()).outboundEmail.count({ where: { organizationId } });
  const messages = async (organizationId = t.orgA.id) =>
    (await db()).message.count({ where: { organizationId, senderType: "USER" } });
  const rejections = (reason: string) => metrics.total("email_outbound_rejected_total", { reason });
  /** Moves every send of an organization back in time, as if it had been made `ms` ago. */
  async function age(ms: number, organizationId = t.orgA.id) {
    const client = await db();
    const rows = await client.outboundEmail.findMany({ where: { organizationId } });
    for (const row of rows) {
      await client.outboundEmail.update({
        where: { id: row.id },
        data: { createdAt: new Date(row.createdAt.getTime() - ms) },
      });
    }
  }

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    await limits();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("limits-secret");
    setEmailProviderForTesting(provider);
    queue = new RecordingQueue();
    setAutomationQueueForTesting(queue);
    await enableEmail(t.orgA.id, "help-a");
    await enableEmail(t.orgB.id, "help-b");
    conversationA = await conversationWith(t.orgA.id, "eve@customer.test");
    metrics.reset();
  });

  afterEach(() => {
    setEmailProviderForTesting(undefined);
    setAutomationQueueForTesting(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });
  afterAll(disconnectDatabase);

  describe("configuration", () => {
    it("has safe defaults, and the environment can only move them within hard ceilings", async () => {
      vi.unstubAllEnvs();
      vi.stubEnv("EMAIL_PROVIDER", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      expect(getOutboundLimits()).toEqual(OUTBOUND_LIMIT_DEFAULTS);
      for (const [key, ceiling] of [
        ["EMAIL_OUTBOUND_ORG_PER_MINUTE", OUTBOUND_LIMIT_CEILINGS.orgPerMinute],
        ["EMAIL_OUTBOUND_ORG_PER_DAY", OUTBOUND_LIMIT_CEILINGS.orgPerDay],
        ["EMAIL_OUTBOUND_USER_PER_MINUTE", OUTBOUND_LIMIT_CEILINGS.userPerMinute],
        ["EMAIL_OUTBOUND_RECIPIENT_PER_HOUR", OUTBOUND_LIMIT_CEILINGS.recipientPerHour],
      ] as const) {
        vi.stubEnv(key, String(ceiling));
        resetServerEnvForTesting();
        expect(() => getOutboundLimits()).not.toThrow();
        vi.stubEnv(key, String(ceiling + 1));
        resetServerEnvForTesting();
        expect(() => getOutboundLimits()).toThrow();
        vi.stubEnv(key, "0");
        resetServerEnvForTesting();
        expect(() => getOutboundLimits()).toThrow();
        vi.stubEnv(key, "");
        resetServerEnvForTesting();
      }
    });
  });

  describe("each dimension", () => {
    it("per recipient: the Nth+1 email to one customer within an hour is refused, and nothing is recorded for it", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "3" });
      for (let i = 0; i < 3; i++) await reply(t.adminA, conversationA);
      const wakeups = queue.jobs.length;
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      expect(await sends()).toBe(3);
      expect(await messages()).toBe(3);
      expect(queue.jobs).toHaveLength(wakeups); // refused before anything was recorded or queued
      expect(rejections("recipient_hour")).toBe(1);
      // Another customer of the same organization is unaffected.
      const other = await conversationWith(t.orgA.id, "ann@customer.test", "Other");
      await expect(reply(t.adminA, other)).resolves.toMatchObject({ duplicate: false });
    });

    it("per organization per minute: across recipients and accounts, and the window slides", async () => {
      await limits({ EMAIL_OUTBOUND_ORG_PER_MINUTE: "2" });
      const second = await conversationWith(t.orgA.id, "ann@customer.test", "Two");
      const third = await conversationWith(t.orgA.id, "bob@customer.test", "Three");
      await reply(t.adminA, conversationA);
      await reply(t.ownerA, second);
      await expect(reply(t.adminA, third)).rejects.toBeInstanceOf(RateLimitError);
      expect(rejections("org_minute")).toBe(1);
      await age(61_000);
      await expect(reply(t.adminA, third)).resolves.toMatchObject({ duplicate: false });
    });

    it("per organization per day: a quota, and it frees up as the window slides", async () => {
      await limits({ EMAIL_OUTBOUND_ORG_PER_DAY: "3", EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "100" });
      for (let i = 0; i < 3; i++) await reply(t.adminA, conversationA);
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      expect(rejections("org_day")).toBe(1);
      await age(23 * 3600_000);
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      await age(2 * 3600_000); // now more than 24 hours old
      await expect(reply(t.adminA, conversationA)).resolves.toMatchObject({ duplicate: false });
    });

    it("per staff account: one account cannot use the whole organization's rate, and others keep theirs", async () => {
      await limits({ EMAIL_OUTBOUND_USER_PER_MINUTE: "2" });
      await reply(t.adminA, conversationA);
      await reply(t.adminA, conversationA);
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      expect(rejections("user_minute")).toBe(1);
      await expect(reply(t.ownerA, conversationA)).resolves.toMatchObject({ duplicate: false });
    });
  });

  describe("tenant isolation", () => {
    it("one organization exhausting its limits does not affect another, and counts never mix", async () => {
      await limits({ EMAIL_OUTBOUND_ORG_PER_MINUTE: "2", EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "2" });
      const conversationB = await conversationWith(t.orgB.id, "eve@customer.test"); // the SAME address
      await reply(t.adminA, conversationA);
      await reply(t.adminA, conversationA);
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      // Org B is untouched by A's usage, including to the same recipient address.
      await reply(t.ownerB, conversationB);
      await reply(t.ownerB, conversationB);
      await expect(reply(t.ownerB, conversationB)).rejects.toBeInstanceOf(RateLimitError);
      expect(await sends(t.orgA.id)).toBe(2);
      expect(await sends(t.orgB.id)).toBe(2);
    });
  });

  describe("concurrency and idempotency keys", () => {
    it("concurrent requests cannot take more than the limit: exactly N succeed, the rest are refused", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "5" });
      const results = await Promise.allSettled(
        Array.from({ length: 14 }, () => reply(t.adminA, conversationA)),
      );
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      expect(refused).toHaveLength(9);
      for (const r of refused) expect(r.reason).toBeInstanceOf(RateLimitError);
      expect(await sends()).toBe(5);
      expect(await messages()).toBe(5);
    });

    it("the same for the organization quota across many recipients at once", async () => {
      await limits({ EMAIL_OUTBOUND_ORG_PER_MINUTE: "4" });
      const conversations = await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          conversationWith(t.orgA.id, `c${i}@customer.test`, `S${i}`),
        ),
      );
      const results = await Promise.allSettled(conversations.map((cid) => reply(t.adminA, cid)));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(4);
      expect(await sends()).toBe(4);
    });

    it("repeating an idempotency key never uses more quota, before or after the limit is reached", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "2" });
      const first = uuid();
      const a = await reply(t.adminA, conversationA, { clientMessageId: first });
      for (let i = 0; i < 4; i++) {
        const again = await reply(t.adminA, conversationA, { clientMessageId: first });
        expect(again).toMatchObject({ duplicate: true, messageId: a.messageId });
      }
      expect(await sends()).toBe(1);
      await reply(t.adminA, conversationA); // the second (new) email: allowed
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError); // third: refused
      // At the limit, the earlier request is still answered with ITS result, not with a refusal.
      await expect(
        reply(t.adminA, conversationA, { clientMessageId: first }),
      ).resolves.toMatchObject({
        duplicate: true,
        messageId: a.messageId,
      });
      expect(await sends()).toBe(2);
    });

    it("a burst of identical requests at the limit creates one email and refuses none of them", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "1" });
      const key = uuid();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reply(t.adminA, conversationA, { clientMessageId: key })),
      );
      expect(new Set(results.map((r) => r.messageId)).size).toBe(1);
      expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
      expect(await sends()).toBe(1);
    });

    it("a new key is a new email and is counted: rotating keys is not a bypass", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "2" });
      await reply(t.adminA, conversationA);
      await reply(t.adminA, conversationA);
      for (let i = 0; i < 5; i++) {
        await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      }
      expect(await sends()).toBe(2);
    });

    it("delivery retries reuse the same row, so they never consume quota", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "1" });
      const key = uuid();
      const { sendId } = await reply(t.adminA, conversationA, { clientMessageId: key });
      provider.failNextSend({ retryable: true, code: "rate_limited" });
      provider.failNextSend({ retryable: true, code: "rate_limited" });
      let clock = new Date();
      const deps = () => ({ now: () => clock, random: () => 0.5 });
      for (let i = 0; i < 3; i++) {
        await processEmailSendJob(
          { kind: "email-send", executionId: `x-${i}`, organizationId: t.orgA.id, sendId },
          deps(),
        );
        clock = new Date(clock.getTime() + 2 * 3600_000);
      }
      expect(provider.sendCalls).toBe(3);
      expect(await sends()).toBe(1);
    });
  });

  describe("what the client sees, and what is monitored", () => {
    it("answers 429 with a generic message: no organization, recipient, count or limit", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "1" });
      as(t.adminA);
      const send = () =>
        call(emailReplyRoute, {
          method: "POST",
          params: { conversationId: conversationA },
          body: { body: "Your order shipped today.", clientMessageId: uuid() },
        });
      expect((await send()).status).toBe(201);
      const refused = await send();
      expect(refused.status).toBe(429);
      expect(refused.body.error.code).toBe("rate_limited");
      const text = JSON.stringify(refused.body);
      expect(text).not.toMatch(/eve@|customer\.test|recipient|hour|minute|quota|limit \d/i);
      expect(text).not.toContain(t.orgA.id);
    });

    it("the Retry-After hint is bounded and carries no tenant data", () => {
      const error = new RateLimitError(900);
      expect(error.status).toBe(429);
      expect(error.headers).toEqual({ "retry-after": "900" });
    });

    it("logs and counts a rejection with codes and the organization id only", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "1" });
      await reply(t.adminA, conversationA);
      await expect(reply(t.adminA, conversationA)).rejects.toBeInstanceOf(RateLimitError);
      const series = Object.keys(metrics.snapshot()).filter((k) =>
        k.startsWith("email_outbound_rejected_total"),
      );
      expect(series).toEqual(["email_outbound_rejected_total{reason=recipient_hour}"]);
    });
  });

  describe("failure behavior: fail closed", () => {
    const fakeTx = (over: Record<string, unknown>) =>
      ({
        $executeRaw: async () => 1,
        outboundEmail: { count: async () => 0 },
        ...over,
      }) as never;
    const input = { organizationId: uuid(), userId: uuid(), toAddress: "eve@customer.test" };

    it("a limiter that cannot take its lock refuses; it never lets the send through", async () => {
      await expect(
        enforceOutboundLimits(
          fakeTx({ $executeRaw: async () => Promise.reject(new Error("db")) }),
          input,
        ),
      ).rejects.toThrow("db");
    });

    it("a limiter that cannot count refuses; it never lets the send through", async () => {
      await expect(
        enforceOutboundLimits(
          fakeTx({ outboundEmail: { count: async () => Promise.reject(new Error("db")) } }),
          input,
        ),
      ).rejects.toThrow("db");
    });

    it("a reply whose recording fails after the check leaves nothing behind and consumes nothing", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "1" });
      const outbound = await import("@/server/repositories/outbound-email");
      vi.spyOn(outbound.outboundEmailRepository, "create").mockRejectedValueOnce(new Error("db"));
      await expect(reply(t.adminA, conversationA)).rejects.toThrow("db");
      expect(await sends()).toBe(0);
      expect(await messages()).toBe(0);
      await expect(reply(t.adminA, conversationA)).resolves.toMatchObject({ duplicate: false });
    });

    it("there is no in-memory counter to lose: a fresh process (module state reset) sees the same usage", async () => {
      await limits({ EMAIL_OUTBOUND_RECIPIENT_PER_HOUR: "1" });
      await reply(t.adminA, conversationA);
      vi.resetModules();
      const fresh = await import("@/server/email/outbound");
      const { requireOrganizationContext: ctxFor } = await import("@/server/auth/context");
      as(t.adminA);
      await expect(
        fresh.createOutboundReply(await ctxFor(), conversationA, {
          body: "again",
          clientMessageId: uuid(),
        }),
      ).rejects.toMatchObject({ status: 429 });
    });
  });
});
