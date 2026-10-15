import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as attentionGet } from "@/app/api/email-outbound/attention/route";
import { POST as recheckPost } from "@/app/api/email-outbound/[sendId]/recheck/route";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import {
  FakeEmailProvider,
  NO_SENDING_GUARANTEES,
  sendingCapabilities,
} from "@/server/email/fake-provider";
import {
  createOutboundReply,
  processEmailSendJob,
  reconcileOutboundEmail,
  type OutboundDeps,
} from "@/server/email/outbound";
import {
  ATTENTION,
  listAttention,
  maskAddress,
  recheckUnknown,
  resolveUnknownAsOperator,
} from "@/server/email/outbound-ops";
import { checkBackgroundHealth } from "@/server/services/background-health";
import { collectGauges, evaluateAlerts } from "@/server/maintenance";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { outboundEmailAuditRepository } from "@/server/repositories/outbound-email-audit";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { signOut } from "../helpers/mocks";
import { RecordingQueue } from "../helpers/recording-queue";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

// Everything the code under test logs is recorded here, so a test can prove nothing sensitive reaches a log line.
const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("@/lib/logger", () => {
  const recorder = (): Record<string, unknown> => ({
    debug: (...a: unknown[]) => logged.push(a),
    info: (...a: unknown[]) => logged.push(a),
    warn: (...a: unknown[]) => logged.push(a),
    error: (...a: unknown[]) => logged.push(a),
    child: () => recorder(),
  });
  return { logger: recorder(), createLogger: () => recorder() };
});
vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const ADDRESS_A = `help-a@${DOMAIN}`;
const ADDRESS_B = `help-b@${DOMAIN}`;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN);

describeDb("outbound email: operational view, UNKNOWN resolution, monitoring", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  let queue: RecordingQueue;
  let customerId: string;
  const db = async () => (await import("@/db/client")).getDb();
  let clock: Date;
  const deps = (over: Partial<OutboundDeps> = {}): OutboundDeps => ({
    now: () => clock,
    random: () => 0.5,
    sendTimeoutMs: 50,
    leaseMs: 60_000,
    ...over,
  });
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };

  async function enableEmail(organizationId: string, address: string) {
    const created = await emailSettingsRepository.create({
      organizationId,
      localPart: address.split("@")[0],
      supportAddress: address,
      fromName: "Acme Support",
    });
    await emailSettingsRepository.setStatus(organizationId, "ACTIVE", null);
    await emailSettingsRepository.setEnabled(organizationId, true);
    return created.id;
  }
  async function emailConversation(organizationId: string, customer: string, subject: string) {
    const client = await db();
    return (
      await client.conversation.create({
        data: {
          organizationId,
          customerId: customer,
          subject,
          channel: "EMAIL",
          lastMessageAt: new Date(),
        },
      })
    ).id;
  }
  const ctxOf = async (user: Parameters<typeof as>[0]) => {
    as(user);
    return requireOrganizationContext();
  };
  let n = 0;
  /** A real send (message + outbound row) in the given organization; returns its ids. */
  async function newSend(
    who = t.adminA,
    orgId = t.orgA.id,
    customer = customerId,
    body = "Secret order details",
  ) {
    n += 1;
    const cid = await emailConversation(orgId, customer, `Subject number ${n}`);
    const r = await createOutboundReply(await ctxOf(who), cid, { body }, deps());
    return { ...r, conversationId: cid, orgId };
  }
  const patch = async (sendId: string, data: Record<string, unknown>) =>
    (await db()).outboundEmail.update({ where: { id: sendId }, data: data as never });
  const row = async (sendId: string) =>
    (await db()).outboundEmail.findUniqueOrThrow({ where: { id: sendId } });
  const run = (sendId: string, over: Partial<OutboundDeps> = {}, organizationId = t.orgA.id) =>
    processEmailSendJob(
      { kind: "email-send", executionId: `x-${sendId}`, organizationId, sendId },
      deps(over),
    );

  /** A send that really went UNKNOWN (ambiguous, provider with no idempotency or lookup at that time). */
  async function unknownSend() {
    provider.sending = NO_SENDING_GUARANTEES;
    const send = await newSend();
    provider.ambiguousNextSend({ delivered: true });
    await run(send.sendId);
    expect((await row(send.sendId)).status).toBe("UNKNOWN");
    return send;
  }

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    // These tests seed many sends to one customer; the abuse limits have their own suite (email-outbound-limits).
    vi.stubEnv("EMAIL_OUTBOUND_RECIPIENT_PER_HOUR", "100");
    vi.stubEnv("EMAIL_OUTBOUND_ORG_PER_MINUTE", "600");
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
    await resetDatabase();
    clock = new Date(Date.now() - 3 * 3600_000);
    t = await setupTenants();
    provider = new FakeEmailProvider("ops-secret");
    setEmailProviderForTesting(provider);
    queue = new RecordingQueue();
    setAutomationQueueForTesting(queue);
    await enableEmail(t.orgA.id, ADDRESS_A);
    customerId = (await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@customer.test" }))
      .id;
    as(t.adminA);
    logged.length = 0;
  });

  afterEach(async () => {
    setEmailProviderForTesting(undefined);
    setAutomationQueueForTesting(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  // ---- the monitoring bug found in review ------------------------------------------------------------------

  describe("worker monitoring: stalled work versus normal waiting", () => {
    it("REGRESSION: the oldest due age is the oldest of EACH kind (an old attempt with a recent lease expiry no longer hides a longer-waiting send)", async () => {
      const waiting = await newSend();
      const inFlight = await newSend();
      // A: due for 30 minutes.   B: attempted 60 minutes ago, its lease expired only 1 minute ago.
      await patch(waiting.sendId, { nextAttemptAt: ago(30) });
      await patch(inFlight.sendId, {
        status: "PROCESSING",
        attempts: 1,
        nextAttemptAt: ago(60),
        lastAttemptAt: ago(2),
        leaseUntil: ago(1),
      });
      const stats = await outboundEmailRepository.stats(new Date());
      expect(stats.due).toBe(2);
      expect(stats.oldestDueAgeSeconds).toBeGreaterThanOrEqual(30 * 60 - 5);
      expect(stats.oldestDueAgeSeconds).toBeLessThan(31 * 60);
      expect(stats.expiredLeases).toBe(1);
    });

    it("a healthy queue with work waiting for its scheduled retry raises nothing", async () => {
      const send = await newSend();
      await patch(send.sendId, {
        status: "RETRY_SCHEDULED",
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 20 * MIN),
        lastErrorCode: "rate_limited",
      });
      const processing = await newSend();
      await patch(processing.sendId, {
        status: "PROCESSING",
        attempts: 1,
        lastAttemptAt: new Date(),
        leaseUntil: new Date(Date.now() + 2 * MIN),
      });
      const gauges = await collectGauges(new Date());
      expect(gauges.outboundEmail).toMatchObject({
        due: 0,
        retryWaiting: 1,
        processing: 1,
        expiredLeases: 0,
        oldestDueAgeSeconds: 0,
      });
      expect(evaluateAlerts(gauges).filter((a) => a.name.startsWith("email_outbound"))).toEqual([]);
      const health = await checkBackgroundHealth(new Date());
      expect(health.checks.outbound).toBe("ok");
      expect(health.details).toMatchObject({ dueEmails: 0, expiredEmailLeases: 0 });
    });

    it("an expired processing lease is counted separately and degrades health once it is overdue", async () => {
      const send = await newSend();
      await patch(send.sendId, {
        status: "PROCESSING",
        attempts: 1,
        lastAttemptAt: ago(30),
        leaseUntil: ago(20),
      });
      const gauges = await collectGauges(new Date());
      expect(gauges.outboundEmail).toMatchObject({ due: 1, expiredLeases: 1, retryWaiting: 0 });
      expect(gauges.outboundEmail.oldestDueAgeSeconds).toBeGreaterThanOrEqual(20 * 60 - 5);
      expect(evaluateAlerts(gauges).map((a) => a.name)).toContain("email_outbound_delayed");
      const health = await checkBackgroundHealth(new Date());
      expect(health).toMatchObject({
        status: "degraded",
        checks: { outbound: "delayed" },
        details: { expiredEmailLeases: 1, dueEmails: 1 },
      });
    });

    it("UNKNOWN is a separate operator signal, not a worker-health failure, and a retry is never 'stalled'", async () => {
      await unknownSend();
      const gauges = await collectGauges(new Date());
      expect(gauges.outboundEmail.unknown).toBe(1);
      expect(evaluateAlerts(gauges).map((a) => a.name)).toEqual(["email_outbound_unknown"]);
      expect((await checkBackgroundHealth(new Date())).checks.outbound).toBe("ok");
    });
  });

  // ---- the attention view -----------------------------------------------------------------------------------

  describe("attention view", () => {
    async function seedMix() {
      const ids: Record<string, string> = {};
      const make = async (key: string, data: Record<string, unknown>) => {
        const s = await newSend();
        ids[key] = s.sendId;
        await patch(s.sendId, data);
      };
      await make("queuedNormal", { nextAttemptAt: new Date() });
      await make("queuedInGrace", { nextAttemptAt: ago(5) });
      await make("queuedOverdue", { nextAttemptAt: ago(15) });
      await make("retryWaiting", {
        status: "RETRY_SCHEDULED",
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 10 * MIN),
      });
      await make("retryOverdue", {
        status: "RETRY_SCHEDULED",
        attempts: 2,
        nextAttemptAt: ago(20),
      });
      await make("processingNormal", {
        status: "PROCESSING",
        attempts: 1,
        lastAttemptAt: new Date(),
        leaseUntil: new Date(Date.now() + MIN),
      });
      await make("leaseJustExpired", {
        status: "PROCESSING",
        attempts: 1,
        lastAttemptAt: ago(3),
        leaseUntil: ago(1),
      });
      await make("leaseStalled", {
        status: "PROCESSING",
        attempts: 1,
        lastAttemptAt: ago(10),
        leaseUntil: ago(5),
      });
      await make("unknown", {
        status: "UNKNOWN",
        attempts: 1,
        lastErrorCode: "timeout",
        lastAttemptAt: ago(60),
      });
      await make("failedRecent", {
        status: "FAILED",
        attempts: 1,
        failedAt: ago(60),
        finalReason: "permanent",
        lastErrorCode: "mailbox_invalid",
      });
      await make("failedOld", {
        status: "FAILED",
        attempts: 1,
        failedAt: ago(40 * 24 * 60),
        finalReason: "permanent",
      });
      await make("sent", {
        status: "SENT",
        attempts: 1,
        sentAt: ago(30),
        providerMessageId: "pm-secret-1",
      });
      return ids;
    }
    const get = (query: Record<string, string> = {}) => call(attentionGet, { query });

    it("lists only what needs attention and clearly separates stalled work from normal queue states", async () => {
      const ids = await seedMix();
      const res = await get();
      expect(res.status).toBe(200);
      const byId = new Map<string, { category: string }>(
        res.body.items.map((i: { id: string; category: string }) => [i.id, i]),
      );
      const listed = (key: string) => byId.get(ids[key])?.category;
      // Needs attention:
      expect(listed("queuedOverdue")).toBe("queued_overdue");
      expect(listed("retryOverdue")).toBe("retry_overdue");
      expect(listed("leaseStalled")).toBe("lease_expired");
      expect(listed("unknown")).toBe("unknown");
      expect(listed("failedRecent")).toBe("failed");
      // Normal, never listed:
      for (const key of [
        "queuedNormal",
        "queuedInGrace",
        "retryWaiting",
        "processingNormal",
        "leaseJustExpired",
        "failedOld",
        "sent",
      ]) {
        expect(listed(key), key).toBeUndefined();
      }
      expect(res.body.summary).toEqual({
        queued_overdue: 1,
        retry_overdue: 1,
        lease_expired: 1,
        unknown: 1,
        failed: 1,
      });
      expect(res.body.total).toBe(5);
    });

    it("filters by category and paginates in a bounded, stable order (oldest first)", async () => {
      await seedMix();
      const only = await get({ category: "unknown" });
      expect(only.body.items).toHaveLength(1);
      expect(only.body.total).toBe(1);
      expect(only.body.summary.failed).toBe(1); // the summary always covers the whole organization

      const first = await get({ pageSize: "2", page: "1" });
      const second = await get({ pageSize: "2", page: "2" });
      const third = await get({ pageSize: "2", page: "3" });
      const all = [...first.body.items, ...second.body.items, ...third.body.items].map(
        (i: { id: string }) => i.id,
      );
      expect(all).toHaveLength(5);
      expect(new Set(all).size).toBe(5);
      expect(first.body.pageSize).toBe(2);
      expect(third.body.items).toHaveLength(1);
    });

    it("bounds page size: a request for more than the cap is refused, and the service caps it anyway", async () => {
      await seedMix();
      expect((await get({ pageSize: "1000" })).status).toBe(400);
      expect((await get({ pageSize: "0" })).status).toBe(400);
      expect((await get({ category: "everything" })).status).toBe(400);
      expect((await get({ unexpected: "1" })).status).toBe(400);
      const page = await listAttention(await ctxOf(t.adminA), { pageSize: 5000 });
      expect(page.pageSize).toBe(ATTENTION.maxPageSize);
    });

    it("exposes no sensitive data: masked recipient, no body, subject, provider id, raw error, lease or Message-ID", async () => {
      const ids = await seedMix();
      const res = await get();
      const unknown = res.body.items.find((i: { id: string }) => i.id === ids.unknown);
      expect(unknown.recipient).toBe("e***@customer.test");
      expect(Object.keys(unknown).sort()).toEqual(
        [
          "canRecheck",
          "category",
          "conversationId",
          "failure",
          "id",
          "messageId",
          "recipient",
          "since",
          "state",
        ].sort(),
      );
      const dump = JSON.stringify(res.body);
      expect(dump).not.toMatch(
        /eve@customer\.test|help-a@|Secret order|Subject number|pm-secret|mailbox_invalid|rate_limited|leaseUntil|rfcMessageId|providerMessageId|fromAddress|toAddress/,
      );
    });

    it("never says anything stronger than the inbox does: failure categories are coarse", async () => {
      const ids = await seedMix();
      const failed = (await get({ category: "failed" })).body.items.find(
        (i: { id: string }) => i.id === ids.failedRecent,
      );
      expect(failed).toMatchObject({ state: "failed", failure: "rejected" });
    });

    it("maskAddress never reveals more than the first letter and the domain", () => {
      expect(maskAddress("eve@customer.test")).toBe("e***@customer.test");
      expect(maskAddress("x@y.test")).toBe("x***@y.test");
      expect(maskAddress("not-an-address")).toBe("***");
      expect(maskAddress("@weird.test")).toBe("***");
    });
  });

  // ---- authorization and isolation --------------------------------------------------------------------------

  describe("authorization and tenant isolation", () => {
    async function orgBSetup() {
      await enableEmail(t.orgB.id, ADDRESS_B);
      const customerB = await seedCustomer(t.orgB.id, {
        firstName: "Bob",
        email: "bob@customer.test",
      });
      const sendB = await newSend(t.ownerB, t.orgB.id, customerB.id, "Bob's private text");
      await patch(sendB.sendId, { nextAttemptAt: ago(30) });
      const sendA = await newSend();
      await patch(sendA.sendId, { nextAttemptAt: ago(30) });
      return { sendA, sendB };
    }

    it("the view and the re-check refuse unauthenticated callers and ordinary members; admins and owners are allowed", async () => {
      const { sendA } = await orgBSetup();
      signOut();
      expect((await call(attentionGet)).status).toBe(401);
      expect(
        (await call(recheckPost, { method: "POST", params: { sendId: sendA.sendId } })).status,
      ).toBe(401);
      as(t.memberA);
      expect((await call(attentionGet)).status).toBe(403);
      expect(
        (await call(recheckPost, { method: "POST", params: { sendId: sendA.sendId } })).status,
      ).toBe(403);
      as(t.adminA);
      expect((await call(attentionGet)).status).toBe(200);
      as(t.ownerA);
      expect((await call(attentionGet)).status).toBe(200);
    });

    it("each organization sees only its own sends, and the counts are its own", async () => {
      const { sendA, sendB } = await orgBSetup();
      as(t.adminA);
      const a = await call(attentionGet);
      expect(a.body.items.map((i: { id: string }) => i.id)).toEqual([sendA.sendId]);
      expect(a.body.summary.queued_overdue).toBe(1);
      as(t.ownerB);
      const b = await call(attentionGet);
      expect(b.body.items.map((i: { id: string }) => i.id)).toEqual([sendB.sendId]);
      expect(JSON.stringify(b.body)).not.toMatch(/eve@|Subject number|help-a@/);
    });

    it("another organization's send cannot be re-checked, and the attempt changes nothing", async () => {
      const { sendA } = await orgBSetup();
      const unknown = await unknownSend();
      as(t.ownerB);
      const res = await call(recheckPost, { method: "POST", params: { sendId: unknown.sendId } });
      expect(res.status).toBe(404);
      expect((await row(unknown.sendId)).status).toBe("UNKNOWN");
      expect(await (await db()).outboundEmailAudit.count()).toBe(0);
      void sendA;
    });

    it("a malformed id is rejected as not found, before anything is read (the project's id convention)", async () => {
      expect(
        (await call(recheckPost, { method: "POST", params: { sendId: "not-a-uuid" } })).status,
      ).toBe(404);
      expect(await (await db()).outboundEmailAudit.count()).toBe(0);
    });

    it("there is no HTTP route that resolves as an operator, marks a send as sent, or resends", async () => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          return statSync(path).isDirectory() ? walk(path) : [path];
        });
      const routes = walk(join(process.cwd(), "src", "app", "api")).filter((f) =>
        /route\.ts$/.test(f),
      );
      const offenders = routes.filter((file) =>
        /resolveUnknownAsOperator|resolveUnknown\(|markSent|scheduleRetry|sendEmail\(|claim\(/.test(
          readFileSync(file, "utf8"),
        ),
      );
      expect(offenders).toEqual([]);
      // And the only code that can leave UNKNOWN is the audited service functions.
      const sources = walk(join(process.cwd(), "src")).filter(
        (f) => /\.ts$/.test(f) && !/\.test\./.test(f) && !f.includes("generated"),
      );
      const users = sources
        .filter((f) => /\.resolveUnknown\(/.test(readFileSync(f, "utf8")))
        .map((f) => f.replace(/\\/g, "/").split("/src/")[1]);
      expect(users).toEqual(["server/email/outbound-ops.ts"]);
    });
  });

  // ---- re-checking an UNKNOWN send --------------------------------------------------------------------------

  describe("re-check with the provider (system evidence)", () => {
    it("the provider HAS it: recorded as accepted with the provider's own id, audited, and nothing is resent", async () => {
      const { sendId, messageId } = await unknownSend();
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null }); // a verified provider that can now be asked
      advance(20 * MIN);
      const result = await recheckUnknown(await ctxOf(t.adminA), sendId, deps());
      expect(result.outcome).toBe("found");
      expect(result.delivery).toMatchObject({ state: "accepted", failure: null });
      const after = await row(sendId);
      expect(after).toMatchObject({
        status: "SENT",
        providerMessageId: provider.sent[0].providerMessageId,
      });
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
      const audits = await outboundEmailAuditRepository.listForSend(t.orgA.id, sendId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "recheck_found",
        previousStatus: "UNKNOWN",
        newStatus: "SENT",
        actorKind: "user",
        actorUserId: t.adminA.id,
        operatorLabel: null,
        reason: null,
      });
      const thread = await (await db()).emailMessage.findFirstOrThrow({ where: { messageId } });
      expect(thread.providerMessageId).toBe(after.providerMessageId);
    });

    it("the provider has NO record: recorded as NOT sent (failed), audited, and still nothing is resent", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const send = await newSend();
      provider.ambiguousNextSend({ delivered: false });
      await run(send.sendId);
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      advance(20 * MIN);
      const result = await recheckUnknown(await ctxOf(t.adminA), send.sendId, deps());
      expect(result.outcome).toBe("no_record");
      expect(result.delivery).toMatchObject({ state: "failed", failure: "provider_no_record" });
      expect(await row(send.sendId)).toMatchObject({
        status: "FAILED",
        finalReason: "provider_has_no_record",
        providerMessageId: null,
      });
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(0);
      expect(
        (await outboundEmailAuditRepository.listForSend(t.orgA.id, send.sendId))[0],
      ).toMatchObject({
        action: "recheck_not_found",
        newStatus: "FAILED",
      });
    });

    it("the provider cannot answer: it STAYS unknown and the attempt is audited", async () => {
      const { sendId } = await unknownSend();
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      provider.lookupUnavailable = true;
      advance(20 * MIN);
      const result = await recheckUnknown(await ctxOf(t.adminA), sendId, deps());
      expect(result).toMatchObject({ outcome: "unavailable", delivery: { state: "unknown" } });
      expect((await row(sendId)).status).toBe("UNKNOWN");
      expect((await outboundEmailAuditRepository.listForSend(t.orgA.id, sendId))[0]).toMatchObject({
        action: "recheck_unavailable",
        previousStatus: "UNKNOWN",
        newStatus: "UNKNOWN",
      });
      expect(provider.sendCalls).toBe(1);
    });

    it("a provider that cannot be asked at all leaves it unknown and refuses (409), with no audit and no state change", async () => {
      const { sendId } = await unknownSend(); // provider declares no lookup
      advance(20 * MIN);
      await expect(recheckUnknown(await ctxOf(t.adminA), sendId, deps())).rejects.toThrow(
        /cannot be asked/i,
      );
      expect((await row(sendId)).status).toBe("UNKNOWN");
      expect(await (await db()).outboundEmailAudit.count()).toBe(0);
    });

    it("refuses while the last attempt is recent (a hung provider call can still complete)", async () => {
      const { sendId } = await unknownSend();
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      advance(2 * MIN);
      await expect(recheckUnknown(await ctxOf(t.adminA), sendId, deps())).rejects.toThrow(
        /too recently/i,
      );
      expect((await row(sendId)).status).toBe("UNKNOWN");
      advance(20 * MIN);
      await expect(recheckUnknown(await ctxOf(t.adminA), sendId, deps())).resolves.toMatchObject({
        outcome: "found",
      });
    });

    it("only an UNKNOWN send can be re-checked", async () => {
      const send = await newSend();
      await expect(recheckUnknown(await ctxOf(t.adminA), send.sendId, deps())).rejects.toThrow(
        /outcome is unknown/i,
      );
      await run(send.sendId);
      await expect(recheckUnknown(await ctxOf(t.adminA), send.sendId, deps())).rejects.toThrow(
        /outcome is unknown/i,
      );
    });

    it("the caller cannot choose the outcome: a body on the request is ignored, only the provider's answer counts", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const send = await newSend();
      provider.ambiguousNextSend({ delivered: false });
      await run(send.sendId);
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      await patch(send.sendId, { lastAttemptAt: ago(60) });
      const res = await call(recheckPost, {
        method: "POST",
        params: { sendId: send.sendId },
        body: { outcome: "sent", providerMessageId: "forged-1", status: "SENT" },
      });
      expect(res.status).toBe(200);
      expect(res.body.outcome).toBe("no_record");
      expect(await row(send.sendId)).toMatchObject({ status: "FAILED", providerMessageId: null });
    });

    it("two concurrent re-checks resolve it exactly once (one audit row for the transition)", async () => {
      const { sendId } = await unknownSend();
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      advance(20 * MIN);
      const ctx = await ctxOf(t.adminA);
      const results = await Promise.allSettled([
        recheckUnknown(ctx, sendId, deps()),
        recheckUnknown(ctx, sendId, deps()),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      const audits = await outboundEmailAuditRepository.listForSend(t.orgA.id, sendId);
      expect(audits.filter((a) => a.action === "recheck_found")).toHaveLength(1);
      expect((await row(sendId)).status).toBe("SENT");
    });

    it("the state change and its audit record commit together: if the audit cannot be written, nothing changes", async () => {
      const { sendId } = await unknownSend();
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      advance(20 * MIN);
      vi.spyOn(outboundEmailAuditRepository, "insert").mockRejectedValueOnce(
        new Error("audit store down"),
      );
      await expect(recheckUnknown(await ctxOf(t.adminA), sendId, deps())).rejects.toThrow(
        "audit store down",
      );
      expect(await row(sendId)).toMatchObject({ status: "UNKNOWN", providerMessageId: null });
      expect(await (await db()).outboundEmailAudit.count()).toBe(0);
    });

    it("works through the route for an allowed caller, and respects the age rule there too", async () => {
      const { sendId } = await unknownSend();
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      await patch(sendId, { lastAttemptAt: new Date() });
      expect((await call(recheckPost, { method: "POST", params: { sendId } })).status).toBe(409);
      await patch(sendId, { lastAttemptAt: ago(30) });
      const ok = await call(recheckPost, { method: "POST", params: { sendId } });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ outcome: "found", delivery: { state: "accepted" } });
    });
  });

  // ---- UNKNOWN can never be blindly resent / stale workers ---------------------------------------------------

  describe("UNKNOWN is never resent and a resolved send is never overwritten", () => {
    it("no worker, job, reconciler pass or re-check ever resends an UNKNOWN send", async () => {
      const { sendId } = await unknownSend();
      const callsBefore = provider.sendCalls;
      for (let i = 0; i < 4; i++) {
        advance(24 * 3600_000);
        await run(sendId);
        await reconcileOutboundEmail(deps());
        provider.lookupUnavailable = true;
        provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
        await recheckUnknown(await ctxOf(t.adminA), sendId, deps()).catch(() => undefined);
      }
      expect(provider.sendCalls).toBe(callsBefore);
      expect(
        queue
          .emailJobs()
          .filter((j) => j.executionId.includes(sendId) && !j.executionId.endsWith("-0")),
      ).toHaveLength(0);
      expect((await row(sendId)).status).toBe("UNKNOWN");
    });

    it("a stale worker cannot overwrite a send that was resolved: not as sent, failed, unknown or retry", async () => {
      const { sendId, orgId } = await unknownSend();
      const stale = (await row(sendId)).attempts; // the attempt number the dead worker held
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      advance(20 * MIN);
      await recheckUnknown(await ctxOf(t.adminA), sendId, deps());
      expect((await row(sendId)).status).toBe("SENT");
      expect(
        await outboundEmailRepository.markFailed(sendId, orgId, stale, "x", "permanent", clock),
      ).toBe(false);
      expect(await outboundEmailRepository.markUnknown(sendId, orgId, stale, "x", clock)).toBe(
        false,
      );
      expect(
        await outboundEmailRepository.scheduleRetry(sendId, orgId, stale, "x", clock, clock),
      ).toBe(false);
      expect(await outboundEmailRepository.markSent(sendId, orgId, stale, "pm-other", clock)).toBe(
        false,
      );
      expect((await row(sendId)).providerMessageId).not.toBe("pm-other");
    });

    it("a resolved send cannot be resolved again, and an in-flight or final one cannot be resolved at all", async () => {
      const unknown = await unknownSend();
      expect(
        await outboundEmailRepository.resolveUnknown(
          unknown.sendId,
          unknown.orgId,
          { kind: "operator_confirmed_not_sent" },
          clock,
        ),
      ).toBe(true);
      expect(
        await outboundEmailRepository.resolveUnknown(
          unknown.sendId,
          unknown.orgId,
          { kind: "provider_lookup_found", providerMessageId: "pm-x" },
          clock,
        ),
      ).toBe(false);
      const pending = await newSend();
      expect(
        await outboundEmailRepository.resolveUnknown(
          pending.sendId,
          pending.orgId,
          { kind: "operator_confirmed_not_sent" },
          clock,
        ),
      ).toBe(false);
      await run(pending.sendId);
      expect(
        await outboundEmailRepository.resolveUnknown(
          pending.sendId,
          pending.orgId,
          { kind: "provider_has_no_record" },
          clock,
        ),
      ).toBe(false);
      expect((await row(pending.sendId)).status).toBe("SENT");
    });
  });

  // ---- operator attestation ---------------------------------------------------------------------------------

  describe("operator attestation (server-side only)", () => {
    const attest = (
      sendId: string,
      over: Partial<Parameters<typeof resolveUnknownAsOperator>[0]> = {},
      d: Partial<OutboundDeps> = {},
    ) =>
      resolveUnknownAsOperator(
        {
          organizationId: t.orgA.id,
          sendId,
          operator: "Dana Ops <dana@example.com>",
          reason: "Checked the provider dashboard: no record of this message id",
          ...over,
        },
        d,
      );

    it("records FAILED (never SENT) with the operator's identity and reason, in an audit row, and does not resend", async () => {
      const { sendId } = await unknownSend();
      await expect(attest(sendId, {}, { now: () => advance(20 * MIN) ?? clock })).resolves.toEqual({
        resolved: true,
      });
      const after = await row(sendId);
      expect(after).toMatchObject({
        status: "FAILED",
        finalReason: "operator_confirmed_not_sent",
        providerMessageId: null,
        sentAt: null,
      });
      expect(after.failedAt).not.toBeNull();
      const audits = await outboundEmailAuditRepository.listForSend(t.orgA.id, sendId);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: "operator_confirmed_not_sent",
        previousStatus: "UNKNOWN",
        newStatus: "FAILED",
        actorKind: "operator",
        actorUserId: null,
        operatorLabel: "Dana Ops <dana@example.com>",
        reason: "Checked the provider dashboard: no record of this message id",
      });
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
      const dto = (await call(attentionGet, { query: { category: "failed" } })).body.items[0];
      expect(dto).toMatchObject({ state: "failed", failure: "operator_confirmed_not_sent" });
    });

    it.each([
      ["no operator identity", { operator: "   " }, /operator identity/i],
      ["an operator label with a line break", { operator: "Dana\nAdmin" }, /operator identity/i],
      ["an over-long operator label", { operator: "x".repeat(121) }, /operator identity/i],
      ["no reason", { reason: "" }, /reason/i],
      ["a reason that is too short", { reason: "ok" }, /reason/i],
      ["an over-long reason", { reason: "x".repeat(501) }, /reason/i],
    ])("refuses %s and changes nothing", async (_label, over, message) => {
      const { sendId } = await unknownSend();
      advance(20 * MIN);
      await expect(attest(sendId, over, deps())).rejects.toThrow(message);
      expect((await row(sendId)).status).toBe("UNKNOWN");
      expect(await (await db()).outboundEmailAudit.count()).toBe(0);
    });

    it("refuses while the last attempt is recent, a missing send, another organization's send, and a send that is not unknown", async () => {
      const { sendId } = await unknownSend();
      await expect(attest(sendId, {}, deps())).rejects.toThrow(/too recently/i);
      advance(20 * MIN);
      await expect(attest(crypto.randomUUID(), {}, deps())).rejects.toThrow(/not found/i);
      await enableEmail(t.orgB.id, ADDRESS_B);
      await expect(attest(sendId, { organizationId: t.orgB.id }, deps())).rejects.toThrow(
        /not found/i,
      );
      const pending = await newSend();
      await expect(attest(pending.sendId, {}, deps())).rejects.toThrow(/outcome is unknown/i);
      expect((await row(sendId)).status).toBe("UNKNOWN");
    });

    it("cannot be applied twice, and the audit is atomic with the change", async () => {
      const { sendId } = await unknownSend();
      advance(20 * MIN);
      vi.spyOn(outboundEmailAuditRepository, "insert").mockRejectedValueOnce(
        new Error("audit store down"),
      );
      await expect(attest(sendId, {}, deps())).rejects.toThrow("audit store down");
      expect((await row(sendId)).status).toBe("UNKNOWN");
      await expect(attest(sendId, {}, deps())).resolves.toBeTruthy();
      await expect(attest(sendId, {}, deps())).rejects.toThrow(/outcome is unknown/i);
      expect(await (await db()).outboundEmailAudit.count()).toBe(1);
    });
  });

  // ---- the audit table's own integrity ----------------------------------------------------------------------

  describe("audit integrity (bypassing the services)", () => {
    async function base() {
      const send = await unknownSend();
      return { client: await db(), send };
    }
    const audit = (send: { sendId: string; orgId: string }, over: Record<string, unknown>) => ({
      organizationId: send.orgId,
      outboundEmailId: send.sendId,
      action: "operator_confirmed_not_sent",
      previousStatus: "UNKNOWN" as const,
      newStatus: "FAILED" as const,
      actorKind: "operator",
      operatorLabel: "Dana",
      reason: "Checked the provider dashboard thoroughly",
      ...over,
    });

    it("accepts a well-formed operator attestation and user re-check", async () => {
      const { client, send } = await base();
      await expect(
        client.outboundEmailAudit.create({ data: audit(send, {}) as never }),
      ).resolves.toBeTruthy();
      await expect(
        client.outboundEmailAudit.create({
          data: audit(send, {
            action: "recheck_found",
            newStatus: "SENT",
            actorKind: "user",
            actorUserId: t.adminA.id,
            operatorLabel: null,
            reason: null,
          }) as never,
        }),
      ).resolves.toBeTruthy();
    });

    it.each([
      ["an operator action that marks the send SENT", { newStatus: "SENT" }],
      ["an operator audit with no reason", { reason: null }],
      ["an operator audit with a trivial reason", { reason: "ok" }],
      ["an operator audit with no identity", { operatorLabel: null }],
      ["an operator audit naming a user", { actorUserId: crypto.randomUUID() }],
      ["a user performing the operator-only action", { actorKind: "user", operatorLabel: null }],
      ["an unknown action", { action: "force_sent" }],
      [
        "a transition that does not match its action",
        {
          action: "recheck_found",
          actorKind: "user",
          actorUserId: crypto.randomUUID(),
          operatorLabel: null,
          newStatus: "FAILED",
        },
      ],
      ["a resolution from a state other than UNKNOWN", { previousStatus: "PENDING" }],
      ["a reason over 500 characters", { reason: "x".repeat(501) }],
      ["a label with a line break", { operatorLabel: "a\nb" }],
    ])("refuses %s", async (_label, over) => {
      const { client, send } = await base();
      await expect(
        client.outboundEmailAudit.create({ data: audit(send, over) as never }),
      ).rejects.toThrow();
    });

    it("refuses an audit row that names another organization's send (composite foreign key)", async () => {
      const { client, send } = await base();
      await enableEmail(t.orgB.id, ADDRESS_B);
      await expect(
        client.outboundEmailAudit.create({
          data: audit({ ...send, orgId: t.orgB.id }, {}) as never,
        }),
      ).rejects.toThrow();
    });

    it("the repository can only insert and read: no function updates or deletes an audit row", () => {
      expect(Object.keys(outboundEmailAuditRepository).sort()).toEqual(["insert", "listForSend"]);
    });
  });

  // ---- privacy of logs ---------------------------------------------------------------------------------------

  describe("logs", () => {
    it("never contain bodies, subjects, full addresses or provider ids across sends, re-checks and attestations", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const send = await newSend(t.adminA, t.orgA.id, customerId, "Highly confidential body text");
      provider.ambiguousNextSend({ delivered: true });
      await run(send.sendId);
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      advance(20 * MIN);
      await recheckUnknown(await ctxOf(t.adminA), send.sendId, deps());
      const other = await unknownSend();
      advance(20 * MIN);
      await resolveUnknownAsOperator(
        {
          organizationId: t.orgA.id,
          sendId: other.sendId,
          operator: "Dana",
          reason: "Checked the provider dashboard",
        },
        deps(),
      );
      await listAttention(await ctxOf(t.adminA), {});
      const dump = JSON.stringify(logged);
      expect(logged.length).toBeGreaterThan(0);
      expect(dump).not.toMatch(
        /Highly confidential|eve@customer\.test|help-a@|Subject number|fake-/,
      );
    });
  });
});
