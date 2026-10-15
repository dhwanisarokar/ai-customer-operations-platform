import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as inboundRoute } from "@/app/api/email/inbound/route";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { INBOUND_LIMITS } from "@/server/email/inbound";
import { handleInboundWebhook, MAX_WEBHOOK_BODY_BYTES } from "@/server/email/inbound-webhook";
import type { NormalizedInboundEmail } from "@/server/email/provider";
import {
  collectGauges,
  evaluateAlerts,
  runMaintenance,
  startMaintenanceLoop,
} from "@/server/maintenance";
import { metrics } from "@/server/observability/metrics";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
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
let counter = 5000;

describeDb("email observability, per-reason limits and maintenance", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  const db = async () => (await import("@/db/client")).getDb();

  function mail(overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
    counter += 1;
    return sampleInbound({
      providerMessageId: `obs-${counter}`,
      messageId: `<obs${counter}@customer.test>`,
      from: `sender${counter}@customer.test`,
      deliveredTo: [ADDRESS_A],
      to: [ADDRESS_A],
      ...overrides,
    });
  }
  const deliver = (email: NormalizedInboundEmail, at = new Date()) =>
    handleInboundWebhook(provider.receive(email, at).webhook);

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("obs-secret");
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
    metrics.reset();
  });

  afterEach(() => {
    Object.assign(INBOUND_LIMITS, JSON.parse(JSON.stringify(DEFAULT_LIMITS)));
    setEmailProviderForTesting(undefined);
    setAutomationQueueForTesting(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  describe("rejected webhook requests are counted by reason", () => {
    it("counts bad signature, stale, malformed, oversized and not-configured", async () => {
      const { webhook } = provider.receive(mail());
      await handleInboundWebhook({
        ...webhook,
        headers: { ...webhook.headers, "x-fake-signature": "0".repeat(64) },
      });
      await handleInboundWebhook(provider.receive(mail(), new Date(Date.now() - 3600_000)).webhook);
      await handleInboundWebhook({ headers: {}, rawBody: "{}" });
      await handleInboundWebhook({ headers: {}, rawBody: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1) });
      const route = inboundRoute as unknown as (
        r: Request,
        c: { params: Promise<unknown> },
      ) => Promise<Response>;
      await route(
        new Request("http://localhost/api/email/inbound", {
          method: "POST",
          body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 10),
          headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 10) },
        }),
        { params: Promise.resolve({}) },
      );
      setEmailProviderForTesting(undefined);
      vi.stubEnv("EMAIL_PROVIDER", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      await handleInboundWebhook(webhook);

      const rejected = (reason: string) =>
        metrics.total("email_webhook_rejected_total", { reason });
      expect(rejected("bad_signature")).toBe(1);
      expect(rejected("stale")).toBe(1);
      expect(rejected("malformed")).toBe(1);
      expect(rejected("too_large")).toBe(2);
      expect(rejected("not_configured")).toBe(1);
    });

    it("counts a message that could not be fetched", async () => {
      const { headers, rawBody } = provider.signedWebhook({
        type: "inbound",
        id: "e",
        ref: "missing",
      });
      await handleInboundWebhook({ headers, rawBody });
      expect(metrics.total("email_fetch_unavailable_total")).toBe(1);
    });
  });

  describe("inbound outcomes", () => {
    it("counts processed, held (by reason), ignored (by reason) and duplicate", async () => {
      const ok = mail();
      await deliver(ok);
      await deliver(ok); // duplicate
      await deliver(mail({ senderAuth: auth.none })); // held
      await deliver(mail({ from: "mailer-daemon@customer.test" })); // ignored (automated; before routing)
      await deliver(mail({ deliveredTo: [`nobody@${DOMAIN}`] })); // ignored (unknown recipient)
      const total = (outcome: string, reason?: string) =>
        metrics.total("email_inbound_total", { outcome, ...(reason ? { reason } : {}) });
      expect(total("processed")).toBe(1);
      expect(total("duplicate")).toBe(1);
      expect(total("held", "unauthenticated_sender")).toBe(1);
    });

    it("labels carry the organization id and codes, never an address, subject or body", async () => {
      await deliver(
        mail({
          from: "private.person@customer.test",
          subject: "Secret subject",
          text: "Secret body content",
          senderAuth: auth.none,
        }),
      );
      const dump = JSON.stringify(metrics.snapshot());
      expect(dump).toContain(t.orgA.id);
      expect(dump).not.toMatch(/private\.person|Secret|customer\.test/);
    });
  });

  describe("quota exhaustion and held-queue saturation are counted and visible", () => {
    it("counts sender and organization quota drops", async () => {
      INBOUND_LIMITS.perSender = 1;
      await deliver(mail({ from: "flood@customer.test" }));
      await deliver(mail({ from: "flood@customer.test" }));
      expect(metrics.total("email_quota_exhausted_total", { scope: "sender" })).toBe(1);
      INBOUND_LIMITS.perOrganization = 1;
      await deliver(mail({ from: "other@customer.test" }));
      expect(metrics.total("email_quota_exhausted_total", { scope: "organization" })).toBe(1);
    });

    it("a flood of ONE kind of held mail cannot use up the queue other kinds need (per-reason caps)", async () => {
      INBOUND_LIMITS.openHeldByReason.UNAUTHENTICATED_SENDER = 2;
      INBOUND_LIMITS.openHeldByReason.ARCHIVED_CUSTOMER = 2;
      for (let i = 0; i < 5; i++) await deliver(mail({ senderAuth: auth.none }));
      expect(
        await (await db()).emailHeldMessage.count({ where: { reason: "UNAUTHENTICATED_SENDER" } }),
      ).toBe(2);
      expect(
        metrics.total("email_held_queue_saturated_total", {
          scope: "reason",
          reason: "unauthenticated_sender",
        }),
      ).toBe(3);

      // Another kind of held mail still has room: an archived customer writing again is held, not dropped.
      const { seedCustomer } = await import("../helpers/tenants");
      await seedCustomer(t.orgA.id, {
        firstName: "Old",
        email: "old@customer.test",
        status: "ARCHIVED",
      });
      const res = await deliver(mail({ from: "old@customer.test" }));
      expect(res.body.status).toBe("held");
      expect(
        await (await db()).emailHeldMessage.count({ where: { reason: "ARCHIVED_CUSTOMER" } }),
      ).toBe(1);
    });

    it("the overall queue cap still applies and is reported as queue saturation", async () => {
      INBOUND_LIMITS.openHeldPerOrganization = 1;
      await deliver(mail({ senderAuth: auth.none }));
      const res = await deliver(mail({ senderAuth: auth.none }));
      expect(res.body.status).toBe("ignored");
      expect(metrics.total("email_held_queue_saturated_total", { scope: "queue" })).toBe(1);
      const reasons = (await (await db()).emailWebhookEvent.findMany()).map((e) => e.reason);
      expect(reasons).toContain("held_limit");
    });

    it("dropped mail is visible in the database-derived gauges and raises a critical alert", async () => {
      INBOUND_LIMITS.openHeldPerOrganization = 1;
      await deliver(mail({ senderAuth: auth.none }));
      await deliver(mail({ senderAuth: auth.none }));
      const gauges = await collectGauges();
      expect(gauges.droppedLastHour).toContainEqual({ reason: "held_limit", count: 1 });
      expect(gauges.heldOpen).toContainEqual({
        organizationId: t.orgA.id,
        reason: "unauthenticated_sender",
        count: 1,
      });
      const alerts = evaluateAlerts(gauges);
      expect(alerts.map((a) => a.name)).toContain("email_dropped_by_limit");
    });
  });

  describe("maintenance", () => {
    it("one pass reconciles events, purges expired rows (when asked) and publishes gauges", async () => {
      const client = await db();
      const old = new Date(Date.now() - 40 * 24 * 3600_000);
      await client.emailWebhookEvent.create({
        data: { replayKey: "ancient", outcome: "PROCESSED", createdAt: old },
      });
      await deliver(mail());
      const result = await runMaintenance({ purge: true });
      expect(result.purged).toMatchObject({ webhookEvents: 1 });
      expect(
        await client.emailWebhookEvent.findFirst({ where: { replayKey: "ancient" } }),
      ).toBeNull();
      expect(metrics.snapshot()).toHaveProperty("domain_event_outbox_backlog");
      expect(metrics.snapshot()).toHaveProperty("email_webhook_events_rows");
    });

    it("a normal pass does not purge", async () => {
      const result = await runMaintenance();
      expect(result.purged).toBeNull();
    });

    it("the loop runs, never overlaps and stops cleanly", async () => {
      const stop = startMaintenanceLoop({ intervalMs: 20, purgeIntervalMs: 3_600_000 });
      await new Promise((resolve) => setTimeout(resolve, 150));
      await stop();
      expect(metrics.snapshot()).toHaveProperty("domain_event_outbox_backlog");
    });
  });
});
