import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider, sendingCapabilities } from "@/server/email/fake-provider";
import {
  createOutboundReply,
  processEmailSendJob,
  reconcileOutboundEmail,
  usableProvider,
  type OutboundDeps,
} from "@/server/email/outbound";
import { recheckUnknown } from "@/server/email/outbound-ops";
import { leaseFor, settleWindowMs } from "@/server/email/outbound-state";
import { metrics } from "@/server/observability/metrics";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { RecordingQueue } from "../helpers/recording-queue";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const ADDRESS_A = `help-a@${DOMAIN}`;
const MIN = 60_000;
const SEND_TIMEOUT = 20; // real milliseconds: a hung fake call is abandoned after this

/**
 * A provider that is NOT idempotent but can be asked: its lookup lags behind acceptance by up to 2 minutes, and a
 * request we stopped waiting for may still be accepted up to 3 minutes after it was sent. Settle window: 5 minutes.
 */
const EVENTUAL = sendingCapabilities({
  idempotentByKey: false,
  keyRetentionMs: null,
  lookupConsistency: "eventual",
  lookupSettleMs: 2 * MIN,
  lateAcceptanceCeilingMs: 3 * MIN,
  lookupRetentionMs: 24 * 60 * MIN,
});
const LEASE = leaseFor(EVENTUAL, SEND_TIMEOUT);

describeDb(
  "outbound email: ambiguous sends are reconciled with the provider's real timing (Phase 9.6)",
  () => {
    let t: Awaited<ReturnType<typeof setupTenants>>;
    let provider: FakeEmailProvider;
    let clock: Date;
    let conversationId: string;
    const db = async () => (await import("@/db/client")).getDb();

    const deps = (over: Partial<OutboundDeps> = {}): OutboundDeps => ({
      now: () => clock,
      random: () => 0.5,
      sendTimeoutMs: SEND_TIMEOUT,
      ...over,
    });
    const advance = (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    };

    async function reply(body = "Hello Eve, your order shipped.") {
      as(t.adminA);
      return createOutboundReply(
        await requireOrganizationContext(),
        conversationId,
        { body },
        deps(),
      );
    }
    const row = async (sendId: string) =>
      (await db()).outboundEmail.findUniqueOrThrow({ where: { id: sendId } });
    const run = (sendId: string, over: Partial<OutboundDeps> = {}) =>
      processEmailSendJob(
        {
          kind: "email-send",
          executionId: `email-send-${sendId}-0`,
          organizationId: t.orgA.id,
          sendId,
        },
        deps(over),
      );
    const total = (result: string, extra: Record<string, string> = {}) =>
      metrics.total("email_outbound_total", { result, ...extra });

    beforeEach(async () => {
      vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
      vi.stubEnv("EMAIL_PROVIDER", "fake");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      await resetDatabase();
      clock = new Date("2026-10-14T12:00:00Z");
      t = await setupTenants();
      provider = new FakeEmailProvider("recon-secret");
      provider.sending = EVENTUAL;
      provider.lookupLagMs = 2 * MIN;
      provider.now = () => clock;
      setEmailProviderForTesting(provider);
      setAutomationQueueForTesting(new RecordingQueue());
      const settings = await emailSettingsRepository.create({
        organizationId: t.orgA.id,
        localPart: "help-a",
        supportAddress: ADDRESS_A,
        fromName: "Acme Support",
      });
      expect(settings.id).toBeTruthy();
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
      as(t.adminA);
      metrics.reset();
    });

    afterEach(() => {
      setEmailProviderForTesting(undefined);
      setAutomationQueueForTesting(undefined);
      vi.unstubAllEnvs();
      vi.restoreAllMocks();
    });
    afterAll(disconnectDatabase);

    it("the test provider's window is what the platform computes (5 minutes), and the lease covers it", () => {
      expect(settleWindowMs(EVENTUAL)).toBe(5 * MIN);
      expect(LEASE).toBeGreaterThan(5 * MIN);
    });

    describe("an immediate 'not found' is not proof (the original finding)", () => {
      it("a request that lands AFTER we stopped waiting is not resent: it stays pending, then is recorded as SENT from the lookup", async () => {
        const { sendId } = await reply();
        provider.lateAcceptNextSend();
        await run(sendId); // times out; the lookup says "not found" because the provider has not accepted it yet

        // Not RETRY_SCHEDULED: nothing is scheduled to be sent again.
        expect(await row(sendId)).toMatchObject({ status: "PROCESSING", attempts: 1 });
        expect(total("settle_pending")).toBe(1);
        expect(provider.abortedCalls).toBe(1); // we asked the adapter to drop it; that proves nothing

        // The provider now accepts the original request.
        expect(provider.completeLateAcceptances()).toBe(1);
        // While the lease is valid nothing touches it, and the reconciler cannot resend.
        advance(LEASE - 1_000);
        expect((await reconcileOutboundEmail(deps())).recovered).toBe(0);
        await run(sendId);
        expect(provider.sendCalls).toBe(1);

        // Lease expired: the lookup now shows the send.
        advance(2_000);
        expect((await reconcileOutboundEmail(deps())).recovered).toBe(1);
        const send = await row(sendId);
        expect(send).toMatchObject({ status: "SENT", attempts: 2 });
        expect(send.providerMessageId).toBe(provider.sent[0].providerMessageId);
        expect(provider.sent).toHaveLength(1);
        expect(provider.sendCalls).toBe(1);
      });

      it("a lookup that lags behind an accepted send does not make it look unsent", async () => {
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: true }); // accepted at the provider, answer lost
        await run(sendId);
        expect(provider.sent).toHaveLength(1);
        // The old code scheduled a resend here (lookup: not found) and, with this provider, delivered a second copy.
        expect(await row(sendId)).toMatchObject({ status: "PROCESSING", attempts: 1 });
        advance(LEASE + 1_000);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({ status: "SENT" });
        advance(24 * 60 * MIN);
        await reconcileOutboundEmail(deps());
        await run(sendId);
        expect(provider.sendCalls).toBe(1);
        expect(provider.sent).toHaveLength(1);
      });

      it("only after the window does 'not found' make a retry safe, and then it delivers exactly once", async () => {
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: false });
        await run(sendId);
        expect((await row(sendId)).status).toBe("PROCESSING");
        advance(LEASE + 1_000);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 2,
          lastErrorCode: "lease_expired",
        });
        expect(provider.sendCalls).toBe(1);
        advance(61_000);
        await run(sendId);
        expect((await row(sendId)).status).toBe("SENT");
        expect(provider.sendCalls).toBe(2);
        expect(provider.sent).toHaveLength(1);
      });

      it("a strongly consistent lookup with no late acceptance still decides at once", async () => {
        provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: false });
        await run(sendId);
        expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
      });

      it("the clock moving during the call counts: a not-found asked after the window is believed immediately", async () => {
        provider.sending = sendingCapabilities({
          idempotentByKey: false,
          keyRetentionMs: null,
          lateAcceptanceCeilingMs: 30_000,
        });
        const { sendId } = await reply();
        const original = provider.sendEmail.bind(provider);
        vi.spyOn(provider, "sendEmail").mockImplementationOnce(async (message, options) => {
          advance(31_000); // the (slow) attempt itself outlasts the ceiling
          provider.hangNextSend({ delivered: false });
          return original(message, options);
        });
        await run(sendId);
        expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
      });
    });

    describe("lookup retention: 'not found' stops meaning anything once the provider forgets", () => {
      it("recovery that happens after the retention window leaves the send UNKNOWN and never resends", async () => {
        provider.sending = { ...EVENTUAL, lookupRetentionMs: 2 * 60 * MIN };
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: false });
        await run(sendId);
        advance(3 * 60 * MIN); // the worker was down for hours; the provider has forgotten the key
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({ status: "UNKNOWN", attempts: 2 });
        expect(provider.sendCalls).toBe(1);
        advance(24 * 60 * MIN);
        await reconcileOutboundEmail(deps());
        await run(sendId);
        expect(provider.sendCalls).toBe(1);
      });

      it("a re-check older than the retention window is inconclusive: nothing changes", async () => {
        provider.sending = { ...EVENTUAL, lookupRetentionMs: 2 * 60 * MIN };
        const { sendId } = await reply();
        provider.lookupUnavailable = true;
        provider.hangNextSend({ delivered: false });
        await run(sendId); // ambiguous and the lookup is down: UNKNOWN at once
        expect((await row(sendId)).status).toBe("UNKNOWN");
        provider.lookupUnavailable = false;
        advance(3 * 60 * MIN);
        const result = await recheckUnknown(await requireOrganizationContext(), sendId, deps());
        expect(result.outcome).toBe("inconclusive");
        expect((await row(sendId)).status).toBe("UNKNOWN");
        const audits = await (
          await db()
        ).outboundEmailAudit.findMany({ where: { outboundEmailId: sendId } });
        expect(audits.map((a) => a.action)).toEqual(["recheck_unavailable"]);
        expect(provider.sendCalls).toBe(1);
      });
    });

    describe("the manual resolution guard follows the provider's timing, not a bare constant", () => {
      async function unknownSend() {
        const { sendId } = await reply();
        provider.lookupUnavailable = true;
        provider.hangNextSend({ delivered: false });
        await run(sendId);
        provider.lookupUnavailable = false;
        expect((await row(sendId)).status).toBe("UNKNOWN");
        return sendId;
      }

      it("refuses until the claim's lease plus the settle window has passed (longer than the 10-minute floor here)", async () => {
        const sendId = await unknownSend();
        const guard = LEASE + settleWindowMs(EVENTUAL);
        expect(guard).toBeGreaterThan(10 * MIN);
        advance(10 * MIN + 1_000); // the old constant would already allow a re-check here
        await expect(
          recheckUnknown(await requireOrganizationContext(), sendId, deps()),
        ).rejects.toThrow(/too recently/i);
        advance(guard - 10 * MIN);
        const result = await recheckUnknown(await requireOrganizationContext(), sendId, deps());
        expect(result.outcome).toBe("no_record");
        expect((await row(sendId)).status).toBe("FAILED");
        expect(provider.sendCalls).toBe(1); // a re-check never resends
      });
    });

    describe("worker takeover and stale attempts", () => {
      it("a worker that hangs through its lease cannot record anything once recovery took over, and nothing is sent twice", async () => {
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: false });
        await run(sendId);
        advance(LEASE + 1_000);
        await reconcileOutboundEmail(deps()); // takeover (attempt 2): not found after the window -> retry scheduled
        expect(
          await outboundEmailRepository.markSent(sendId, t.orgA.id, 1, "pm-stale", clock),
        ).toBe(false);
        expect(
          await outboundEmailRepository.markFailed(sendId, t.orgA.id, 1, "x", "permanent", clock),
        ).toBe(false);
        expect(await row(sendId)).toMatchObject({ status: "RETRY_SCHEDULED", attempts: 2 });
        expect(provider.sent).toHaveLength(0);
      });

      it("two recoverers race for an expired attempt: exactly one resolves it, the provider is asked once per winner", async () => {
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: true });
        await run(sendId);
        advance(LEASE + 1_000);
        const results = await Promise.all([
          reconcileOutboundEmail(deps()),
          reconcileOutboundEmail(deps()),
        ]);
        expect(results.reduce((n, r) => n + r.recovered, 0)).toBe(1);
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 2 });
        expect(provider.sent).toHaveLength(1);
      });

      it("a takeover leaves lastAttemptAt (the claim time) alone: it is the age bound for the lookup's retention", async () => {
        const { sendId } = await reply();
        const claimed = await outboundEmailRepository.claim(
          sendId,
          t.orgA.id,
          clock,
          new Date(clock.getTime() + MIN),
        );
        expect(claimed?.lastAttemptAt?.getTime()).toBe(clock.getTime());
        advance(2 * MIN);
        const taken = await outboundEmailRepository.takeOverExpired(
          sendId,
          t.orgA.id,
          clock,
          new Date(clock.getTime() + MIN),
        );
        expect(taken).toMatchObject({ attempts: 2 });
        expect(taken?.lastAttemptAt?.getTime()).toBe(claimed?.lastAttemptAt?.getTime());
      });

      it("recovery that finds the settle window NOT yet over (a lease shorter than the window) waits instead of resending", async () => {
        const { sendId } = await reply();
        // A claim whose lease was shorter than the provider's window (e.g. written before a configuration change).
        await outboundEmailRepository.claim(
          sendId,
          t.orgA.id,
          clock,
          new Date(clock.getTime() + MIN),
        );
        advance(2 * MIN);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({ status: "PROCESSING", attempts: 2 });
        expect(provider.sendCalls).toBe(0);
        expect(total("recovered", { reason: "await_settle" })).toBe(1);
      });
    });

    describe("the lease guard: a call never starts when its lease could expire before the window ends", () => {
      it("a claim with too little lease left extends its OWN lease first, then calls the provider once", async () => {
        const { sendId } = await reply();
        await run(sendId, { leaseMs: 2 * MIN }); // shorter than the 5-minute window
        expect(provider.sendCalls).toBe(1);
        expect((await row(sendId)).status).toBe("SENT");
        expect(total("lease_extended")).toBe(1);
      });

      it("if the extension is refused (recovery took the send over, or the database failed) NO call is made", async () => {
        const { sendId } = await reply();
        vi.spyOn(outboundEmailRepository, "extendLease").mockResolvedValueOnce(false);
        await run(sendId, { leaseMs: 2 * MIN });
        expect(provider.sendCalls).toBe(0);
        expect(await row(sendId)).toMatchObject({ status: "PROCESSING", attempts: 1, retries: 0 });
        expect(total("lease_extend_refused")).toBe(1);
      });

      it("the default lease for this provider is long enough for the call to start without any extension", async () => {
        const { sendId } = await reply();
        await run(sendId);
        expect(provider.sendCalls).toBe(1);
        expect((await row(sendId)).status).toBe("SENT");
        expect(total("lease_extended")).toBe(0);
      });
    });

    describe("database failure AFTER the provider accepted", () => {
      it("the outcome could not be recorded: the row stays PROCESSING, recovery finds it SENT, nothing is resent", async () => {
        const { sendId } = await reply();
        vi.spyOn(outboundEmailRepository, "markSent").mockRejectedValueOnce(new Error("db down"));
        await run(sendId);
        expect(provider.sent).toHaveLength(1);
        expect(await row(sendId)).toMatchObject({ status: "PROCESSING", attempts: 1 });
        expect(total("finalize_failed")).toBe(1);
        advance(LEASE + 1_000);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 2 });
        expect(provider.sendCalls).toBe(1);
        expect(provider.sent).toHaveLength(1);
      });

      it("recording a retry fails after an ambiguous call: nothing is lost and the send is not resent early", async () => {
        const { sendId } = await reply();
        provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
        provider.hangNextSend({ delivered: false });
        vi.spyOn(outboundEmailRepository, "scheduleRetry").mockRejectedValueOnce(
          new Error("db down"),
        );
        await run(sendId);
        expect(await row(sendId)).toMatchObject({ status: "PROCESSING", attempts: 1 });
        advance(LEASE + 1_000);
        await reconcileOutboundEmail(deps());
        expect(provider.sendCalls).toBe(1);
        expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
      });
    });

    describe("provider capability policy at the point of use", () => {
      it("a provider whose declarations are unsafe is never used: nothing is queued or sent, and it is counted", async () => {
        provider.sending = sendingCapabilities({ idempotentByKey: true, keyRetentionMs: 60_000 });
        expect(usableProvider()).toBeNull();
        as(t.adminA);
        await expect(
          createOutboundReply(
            await requireOrganizationContext(),
            conversationId,
            { body: "hi" },
            deps(),
          ),
        ).rejects.toThrow(/not set up/i);
        expect(await (await db()).outboundEmail.count()).toBe(0);
        expect(
          metrics.total("email_provider_rejected_total", {
            reason: "idempotent_retention_too_short",
          }),
        ).toBeGreaterThan(0);
      });

      it("a send queued before the provider became unusable is not delivered and not lost", async () => {
        const { sendId } = await reply();
        provider.sending = sendingCapabilities({ lookupByKey: true, lookupConsistency: "none" });
        await run(sendId);
        expect(provider.sendCalls).toBe(0);
        expect((await row(sendId)).status).toBe("PENDING");
        provider.sending = EVENTUAL;
        await run(sendId);
        expect((await row(sendId)).status).toBe("SENT");
      });
    });
  },
);
