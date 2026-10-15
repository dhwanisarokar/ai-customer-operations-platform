import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as backgroundHealthRoute } from "@/app/api/health/background/route";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { INBOUND_LIMITS } from "@/server/email/inbound";
import { handleInboundWebhook, purgeExpiredWebhookEvents } from "@/server/email/inbound-webhook";
import type { NormalizedInboundEmail } from "@/server/email/provider";
import { expireHeldMessages } from "@/server/email/retention";
import { reconcileOutbox } from "@/server/events/outbox";
import { MAINTENANCE_HEARTBEAT, runMaintenance, startMaintenanceLoop } from "@/server/maintenance";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { workerHeartbeatRepository } from "@/server/repositories/worker-heartbeat";
import { checkBackgroundHealth } from "@/server/services/background-health";
import { auth } from "../helpers/email-auth";
import { sampleInbound } from "../helpers/email-provider-contract";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const ADDRESS_A = `help-a@${DOMAIN}`;
const DEFAULT_LIMITS = JSON.parse(JSON.stringify(INBOUND_LIMITS)) as typeof INBOUND_LIMITS;
const DAY = 24 * 3600_000;
let counter = 9000;

describeDb("readiness: worker health, quota, retention, replay policy", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  const db = async () => (await import("@/db/client")).getDb();
  const resetEnv = async () => (await import("@/lib/env")).resetServerEnvForTesting();

  function mail(overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
    counter += 1;
    return sampleInbound({
      providerMessageId: `ready-${counter}`,
      messageId: `<ready${counter}@customer.test>`,
      from: `sender${counter}@customer.test`,
      deliveredTo: [ADDRESS_A],
      to: [ADDRESS_A],
      ...overrides,
    });
  }
  const deliver = (email: NormalizedInboundEmail) =>
    handleInboundWebhook(provider.receive(email).webhook);

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    await resetEnv();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("ready-secret");
    setEmailProviderForTesting(provider);
    setAutomationQueueForTesting(new MemoryAutomationQueue({ backoffBaseMs: 0 }));
    await emailSettingsRepository.create({
      organizationId: t.orgA.id,
      localPart: "help-a",
      supportAddress: ADDRESS_A,
      fromName: "Support",
    });
    await emailSettingsRepository.setStatus(t.orgA.id, "ACTIVE", null);
    await emailSettingsRepository.setEnabled(t.orgA.id, true);
    as(t.adminA);
  });

  afterEach(async () => {
    Object.assign(INBOUND_LIMITS, JSON.parse(JSON.stringify(DEFAULT_LIMITS)));
    setEmailProviderForTesting(undefined);
    setAutomationQueueForTesting(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await resetEnv();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  describe("worker heartbeat and background health", () => {
    it("a completed maintenance pass records the heartbeat", async () => {
      await runMaintenance();
      const beat = await workerHeartbeatRepository.find(MAINTENANCE_HEARTBEAT);
      expect(beat?.lastSuccessAt).not.toBeNull();
      expect(beat?.lastError).toBeNull();
    });

    it("a failing pass records a failure without moving the last success", async () => {
      await runMaintenance();
      const before = await workerHeartbeatRepository.find(MAINTENANCE_HEARTBEAT);
      const outbox = await import("@/server/events/outbox");
      vi.spyOn(outbox, "reconcileOutbox").mockRejectedValue(new Error("db blip"));
      const stop = startMaintenanceLoop({ intervalMs: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 300));
      await stop();
      const after = await workerHeartbeatRepository.find(MAINTENANCE_HEARTBEAT);
      expect(after?.lastError).toBe("maintenance_failed");
      expect(after?.lastSuccessAt?.getTime()).toBe(before?.lastSuccessAt?.getTime());
      expect(after?.lastRunAt.getTime()).toBeGreaterThanOrEqual(before!.lastRunAt.getTime());
    });

    it("health: development without Redis does not require a worker", async () => {
      expect(await checkBackgroundHealth()).toMatchObject({
        status: "ok",
        checks: { worker: "not_required", events: "ok" },
      });
    });

    it("health: with a worker required, never -> ok after a pass -> stale when it stops", async () => {
      vi.stubEnv("AUTOMATION_QUEUE_DRIVER", "bullmq");
      await resetEnv();
      expect(await checkBackgroundHealth()).toMatchObject({
        status: "degraded",
        checks: { worker: "never" },
      });
      await runMaintenance();
      expect(await checkBackgroundHealth()).toMatchObject({
        status: "ok",
        checks: { worker: "ok" },
      });
      // Ten minutes later with no further pass: the worker is stopped.
      const later = new Date(Date.now() + 10 * 60_000);
      expect(await checkBackgroundHealth(later)).toMatchObject({
        status: "degraded",
        checks: { worker: "stale" },
      });
    });

    it("health sees stuck events even when no worker ever ran (a dead worker cannot report itself)", async () => {
      await (
        await db()
      ).domainEventOutbox.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: t.orgA.id,
          type: "message.created",
          data: {},
          occurredAt: new Date(Date.now() - 20 * 60_000),
          createdAt: new Date(Date.now() - 20 * 60_000),
          leaseUntil: new Date(0),
        },
      });
      const health = await checkBackgroundHealth();
      expect(health).toMatchObject({ status: "degraded", checks: { events: "delayed" } });
      expect(health.details.oldestUnpublishedEventSeconds).toBeGreaterThanOrEqual(1200);
    });

    it("the HTTP route answers 200 when healthy and 503 when degraded, with no tenant data", async () => {
      const get = backgroundHealthRoute as unknown as () => Promise<Response>;
      const ok = await get();
      expect(ok.status).toBe(200);
      vi.stubEnv("AUTOMATION_QUEUE_DRIVER", "bullmq");
      await resetEnv();
      const bad = await get();
      expect(bad.status).toBe(503);
      const body = await bad.json();
      expect(body.checks.worker).toBe("never");
      expect(JSON.stringify(body)).not.toContain(t.orgA.id);
    });

    it("the loop stops gracefully: stop() waits for an in-flight pass and none starts afterwards", async () => {
      const outbox = await import("@/server/events/outbox");
      let finished = false;
      vi.spyOn(outbox, "reconcileOutbox").mockImplementation(async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        finished = true;
        return { claimed: 0, published: 0, failed: 0 };
      });
      const stop = startMaintenanceLoop({ intervalMs: 20 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      await stop();
      expect(finished).toBe(true);
      const calls = vi.mocked(outbox.reconcileOutbox).mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(vi.mocked(outbox.reconcileOutbox).mock.calls.length).toBe(calls);
    });
  });

  describe("organization quota and spoofed mail", () => {
    it("spoofed (unauthenticated) mail cannot use up the organization's hourly quota", async () => {
      INBOUND_LIMITS.perOrganization = 2;
      for (let i = 0; i < 6; i++) await deliver(mail({ senderAuth: auth.none }));
      expect(await (await db()).emailHeldMessage.count()).toBe(6);
      // The quota is still fully available to legitimate customers.
      expect((await deliver(mail())).body.status).toBe("processed");
      expect((await deliver(mail())).body.status).toBe("processed");
      const third = await deliver(mail());
      expect(third.body.status).toBe("ignored");
      const reasons = (await (await db()).emailWebhookEvent.findMany()).map((e) => e.reason);
      expect(reasons).toContain("rate_limited_organization");
    });

    it("mail held for another reason (an archived customer) still counts against the quota", async () => {
      INBOUND_LIMITS.perOrganization = 1;
      const { seedCustomer } = await import("../helpers/tenants");
      await seedCustomer(t.orgA.id, {
        firstName: "Old",
        email: "old@customer.test",
        status: "ARCHIVED",
      });
      expect((await deliver(mail({ from: "old@customer.test" }))).body.status).toBe("held");
      expect((await deliver(mail())).body.status).toBe("ignored");
    });
  });

  describe("held-mail expiry", () => {
    const heldRow = (providerMessageId: string, ageDays: number, resolved = false) => ({
      organizationId: "" as string,
      reason: "ARCHIVED_CUSTOMER" as const,
      providerMessageId,
      fromAddress: "a@customer.test",
      subject: "s",
      body: "b",
      spf: "none",
      dkim: "none",
      receivedAt: new Date(),
      createdAt: new Date(Date.now() - ageDays * DAY),
      resolvedAt: resolved ? new Date() : null,
    });

    it("discards unresolved held mail older than 30 days and keeps everything else", async () => {
      const client = await db();
      await client.emailHeldMessage.createMany({
        data: [
          { ...heldRow("old", 31), organizationId: t.orgA.id },
          { ...heldRow("recent", 5), organizationId: t.orgA.id },
          { ...heldRow("old-but-resolved", 90, true), organizationId: t.orgA.id },
        ],
      });
      expect(await expireHeldMessages()).toBe(1);
      expect(
        (await client.emailHeldMessage.findMany()).map((r) => r.providerMessageId).sort(),
      ).toEqual(["old-but-resolved", "recent"]);
    });

    it("refuses a retention below the floor", async () => {
      await expect(expireHeldMessages({ olderThanDays: 13 })).rejects.toThrow(/at least 14/);
    });

    it("frees the queue: expiry makes room that a full queue had refused", async () => {
      INBOUND_LIMITS.openHeldPerOrganization = 1;
      INBOUND_LIMITS.openHeldByReason.UNAUTHENTICATED_SENDER = 1;
      const client = await db();
      await deliver(mail({ senderAuth: auth.none }));
      expect((await deliver(mail({ senderAuth: auth.none }))).body.status).toBe("ignored");
      await client.emailHeldMessage.updateMany({
        data: { createdAt: new Date(Date.now() - 31 * DAY) },
      });
      await expireHeldMessages();
      expect((await deliver(mail({ senderAuth: auth.none }))).body.status).toBe("held");
    });

    it("runs in the hourly purge step of maintenance", async () => {
      await (
        await db()
      ).emailHeldMessage.create({ data: { ...heldRow("ancient", 40), organizationId: t.orgA.id } });
      const result = await runMaintenance({ purge: true });
      expect(result.purged?.heldEmails).toBe(1);
    });
  });

  describe("replay policy drives retention", () => {
    class LongHorizonProvider extends FakeEmailProvider {
      // Retries the ORIGINAL signed request for up to 20 days: freshness must cover it, and the ledger
      // must outlive twice the 40-day span (80 days).
      override readonly replay = {
        freshnessSeconds: 20 * 86_400,
        retryHorizonSeconds: 20 * 86_400,
        retriesResigned: false,
      } as never;
    }

    it("the ledger keeps entries the provider's retry span could still replay, whatever was requested", async () => {
      setEmailProviderForTesting(new LongHorizonProvider("long"));
      const client = await db();
      await client.emailWebhookEvent.createMany({
        data: [
          {
            replayKey: "thirty-five-days",
            outcome: "PROCESSED",
            createdAt: new Date(Date.now() - 35 * DAY),
          },
          {
            replayKey: "hundred-days",
            outcome: "PROCESSED",
            createdAt: new Date(Date.now() - 100 * DAY),
          },
        ],
      });
      expect(await purgeExpiredWebhookEvents({ olderThanDays: 30 })).toBe(1);
      expect((await client.emailWebhookEvent.findMany()).map((r) => r.replayKey)).toEqual([
        "thirty-five-days",
      ]);
    });

    it("held-mail expiry honors the same floor (deleting a held row forgets its dedup key)", async () => {
      setEmailProviderForTesting(new LongHorizonProvider("long"));
      const client = await db();
      await client.emailHeldMessage.create({
        data: {
          organizationId: t.orgA.id,
          reason: "ARCHIVED_CUSTOMER",
          providerMessageId: "thirty-five",
          fromAddress: "a@customer.test",
          subject: "s",
          body: "b",
          spf: "none",
          dkim: "none",
          receivedAt: new Date(),
          createdAt: new Date(Date.now() - 35 * DAY),
        },
      });
      expect(await expireHeldMessages()).toBe(0);
    });
  });

  describe("outbox: a poison event never starves the others", () => {
    it("with a batch size of one, an event that always fails is skipped on the next pass", async () => {
      const client = await db();
      const base = {
        organizationId: t.orgA.id,
        data: {},
        leaseUntil: new Date(0),
        occurredAt: new Date(),
      };
      const poison = crypto.randomUUID();
      const good = crypto.randomUUID();
      await client.domainEventOutbox.create({
        data: {
          ...base,
          id: poison,
          type: "something.unknown",
          createdAt: new Date(Date.now() - 2000),
        },
      });
      await client.domainEventOutbox.create({
        data: {
          ...base,
          id: good,
          type: "customer.created",
          createdAt: new Date(Date.now() - 1000),
          data: { customerId: crypto.randomUUID(), status: "ACTIVE", company: null, source: null },
        },
      });
      const first = await reconcileOutbox({ limit: 1 });
      expect(first).toMatchObject({ claimed: 1, failed: 1 });
      const second = await reconcileOutbox({ limit: 1 });
      expect(second).toMatchObject({ claimed: 1, published: 1 });
      expect(
        (await client.domainEventOutbox.findUniqueOrThrow({ where: { id: good } })).publishedAt,
      ).not.toBeNull();
      expect(
        (await client.domainEventOutbox.findUniqueOrThrow({ where: { id: poison } })).publishedAt,
      ).toBeNull();
    });
  });
});
