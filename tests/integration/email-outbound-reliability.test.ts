import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import type { AutomationQueue } from "@/server/automation/queue/types";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider, sendingCapabilities } from "@/server/email/fake-provider";
import {
  createOutboundReply,
  processEmailSendJob,
  reconcileOutboundEmail,
  type OutboundDeps,
} from "@/server/email/outbound";
import { recheckUnknown } from "@/server/email/outbound-ops";
import { leaseFor } from "@/server/email/outbound-state";
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
const MIN = 60_000;
const SEND_TIMEOUT = 20;

/** Not idempotent; the lookup lags up to 2 minutes and a request may land up to 3 minutes late: a 5-minute window. */
const EVENTUAL = sendingCapabilities({
  idempotentByKey: false,
  keyRetentionMs: null,
  lookupConsistency: "eventual",
  lookupSettleMs: 2 * MIN,
  lateAcceptanceCeilingMs: 3 * MIN,
  lookupRetentionMs: 24 * 60 * MIN,
});
const LEASE = leaseFor(EVENTUAL, SEND_TIMEOUT);

/** A queue that cannot be reached (Redis down) until `up` is set. */
class FlakyQueue implements AutomationQueue {
  readonly driver = "bullmq" as const;
  up = false;
  readonly jobs: unknown[] = [];
  async enqueue(job: unknown): Promise<void> {
    if (!this.up) throw new Error("redis unavailable");
    this.jobs.push(job);
  }
  async startWorker() {
    return { close: async () => undefined };
  }
  async close() {}
}

describeDb(
  "outbound email reliability (Phase 9.7): accounting, concurrency, failure recovery",
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
    async function reply() {
      as(t.adminA);
      return createOutboundReply(
        await requireOrganizationContext(),
        conversationId,
        { body: "Hello Eve, your order shipped.", clientMessageId: crypto.randomUUID() },
        deps(),
      );
    }
    const row = async (id: string) =>
      (await db()).outboundEmail.findUniqueOrThrow({ where: { id } });
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
    /** A worker claimed the send and died: no provider call was made. */
    const crashedClaim = (sendId: string, leaseMs: number) =>
      outboundEmailRepository.claim(sendId, t.orgA.id, clock, new Date(clock.getTime() + leaseMs));

    beforeEach(async () => {
      vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
      vi.stubEnv("EMAIL_PROVIDER", "fake");
      vi.stubEnv("EMAIL_OUTBOUND_RECIPIENT_PER_HOUR", "100");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      await resetDatabase();
      clock = new Date("2026-10-14T12:00:00Z");
      t = await setupTenants();
      provider = new FakeEmailProvider("rel-secret");
      provider.sending = EVENTUAL;
      provider.lookupLagMs = 2 * MIN;
      provider.now = () => clock;
      setEmailProviderForTesting(provider);
      setAutomationQueueForTesting(new RecordingQueue());
      await emailSettingsRepository.create({
        organizationId: t.orgA.id,
        localPart: "help-a",
        supportAddress: `help-a@${DOMAIN}`,
        fromName: "Acme Support",
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

    describe("attempt accounting: ownership counter vs retry budget vs provider calls", () => {
      it("a plain send: one claim, no retry used, one provider call", async () => {
        const { sendId } = await reply();
        await run(sendId);
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 1, retries: 0 });
        expect(provider.sendCalls).toBe(1);
      });

      it("only a retry that follows a provider call moves the budget; the fence moves on every claim and takeover", async () => {
        const { sendId } = await reply();
        provider.sending = sendingCapabilities(); // immediately decisive provider: simple counting
        provider.failNextSend({ retryable: true, code: "rate_limited" });
        await run(sendId);
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 1,
          retries: 1,
        });
        advance(10 * MIN);
        await run(sendId);
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 2, retries: 1 });
        expect(provider.sendCalls).toBe(2);
      });

      it("repeated recovery checks while the settle window is open consume NO budget and are bounded", async () => {
        const { sendId } = await reply();
        await crashedClaim(sendId, MIN); // the worker died; the (unknown) request may have been sent
        // 15 reconciler passes, 10 s apart: beyond the original 1-minute lease, inside the 5-minute window.
        advance(2 * MIN);
        for (let pass = 0; pass < 15; pass++) {
          await reconcileOutboundEmail(deps());
          advance(10_000);
        }
        const during = await row(sendId);
        // One takeover (attempts 2) that found the window open and moved the lease to the end of the window, then silence.
        expect(during).toMatchObject({ status: "PROCESSING", attempts: 2, retries: 0 });
        expect(provider.sendCalls).toBe(0);
        expect(total("recovered", { reason: "await_settle" })).toBe(1);
        // The window ends: the next check believes "not found" (nothing was ever accepted) and schedules ONE retry.
        advance(6 * MIN);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 3,
          retries: 1,
        });
        advance(10 * MIN);
        await run(sendId);
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 4, retries: 1 });
        expect(provider.sendCalls).toBe(1); // the ONLY provider call in the whole history
      });

      it("a lease that was shorter than the window cannot make recovery spin: the attempt counter stays far from its database bound", async () => {
        const { sendId } = await reply();
        await crashedClaim(sendId, 30_000);
        for (let pass = 0; pass < 200; pass++) {
          advance(30_000);
          await reconcileOutboundEmail(deps());
        }
        expect((await row(sendId)).attempts).toBeLessThanOrEqual(6); // the bound is 50 (database CHECK)
        expect((await row(sendId)).retries).toBeLessThanOrEqual(1);
      });

      it("a lost attempt is one budget unit, but never more: crash, recover, then two failures exhaust a budget of 3 after exactly 2 calls", async () => {
        provider.sending = sendingCapabilities();
        const { sendId } = await reply();
        await crashedClaim(sendId, MIN);
        advance(2 * MIN);
        await reconcileOutboundEmail(deps({ maxAttempts: 3 }));
        // Takeover happened (attempts 2) but the budget is untouched except for the one lost attempt.
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 2,
          retries: 1,
        });
        provider.failNextSend({ retryable: true });
        provider.failNextSend({ retryable: true });
        advance(10 * MIN);
        await run(sendId, { maxAttempts: 3 });
        expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
        advance(10 * MIN);
        await run(sendId, { maxAttempts: 3 });
        expect(await row(sendId)).toMatchObject({
          status: "FAILED",
          finalReason: "retries_exhausted",
          retries: 2,
        });
        expect(provider.sendCalls).toBe(2);
      });

      it("a claim whose final lease check fails after the extension (the clock jumped) makes no call and spends no budget", async () => {
        const { sendId } = await reply();
        const original = outboundEmailRepository.extendLease.bind(outboundEmailRepository);
        vi.spyOn(outboundEmailRepository, "extendLease").mockImplementationOnce(async (...args) => {
          const ok = await original(...args);
          advance(10 * MIN); // the process was paused right after the extension
          return ok;
        });
        await run(sendId, { leaseMs: 2 * MIN });
        expect(provider.sendCalls).toBe(0);
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 1,
          retries: 0,
          lastErrorCode: "lease_too_short",
        });
        expect(total("lease_too_short")).toBe(1);
      });

      it("scheduleRetry spends budget only when the attempt called the provider", async () => {
        const { sendId } = await reply();
        const claimed = await crashedClaim(sendId, MIN);
        expect(
          await outboundEmailRepository.scheduleRetry(
            sendId,
            t.orgA.id,
            claimed!.attempts,
            "lease_too_short",
            clock,
            clock,
            undefined,
            false,
          ),
        ).toBe(true);
        expect((await row(sendId)).retries).toBe(0);
        const again = await crashedClaim(sendId, MIN);
        expect(
          await outboundEmailRepository.scheduleRetry(
            sendId,
            t.orgA.id,
            again!.attempts,
            "rate_limited",
            clock,
            clock,
          ),
        ).toBe(true);
        expect((await row(sendId)).retries).toBe(1);
      });

      it("extendLease is fenced, never shortens a lease, and changes nothing else", async () => {
        const { sendId } = await reply();
        const claimed = await crashedClaim(sendId, 10 * MIN);
        const later = new Date(clock.getTime() + 20 * MIN);
        expect(
          await outboundEmailRepository.extendLease(
            sendId,
            t.orgA.id,
            claimed!.attempts + 1,
            later,
            clock,
          ),
        ).toBe(false); // a stale or foreign attempt number
        expect(
          await outboundEmailRepository.extendLease(
            sendId,
            t.orgB.id,
            claimed!.attempts,
            later,
            clock,
          ),
        ).toBe(false); // another tenant
        expect(
          await outboundEmailRepository.extendLease(
            sendId,
            t.orgA.id,
            claimed!.attempts,
            new Date(clock.getTime() + MIN),
            clock,
          ),
        ).toBe(false); // earlier than the current lease: refused
        expect(
          await outboundEmailRepository.extendLease(
            sendId,
            t.orgA.id,
            claimed!.attempts,
            later,
            clock,
          ),
        ).toBe(true);
        expect(await row(sendId)).toMatchObject({
          status: "PROCESSING",
          attempts: 1,
          retries: 0,
          leaseUntil: later,
        });
      });

      it("an extension that fails during recovery is harmless: the send is simply checked again, and still sent once", async () => {
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: true });
        await run(sendId);
        advance(LEASE + 1_000);
        // Pretend the provider's lag is longer than the lease allowed for, so recovery meets an open window.
        provider.sending = { ...EVENTUAL, lookupSettleMs: 30 * MIN };
        provider.lookupLagMs = 20 * MIN;
        vi.spyOn(outboundEmailRepository, "extendLease").mockRejectedValueOnce(
          new Error("db down"),
        );
        await reconcileOutboundEmail(deps());
        expect((await row(sendId)).status).toBe("PROCESSING");
        advance(40 * MIN);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({ status: "SENT" });
        expect(provider.sendCalls).toBe(1);
        expect(provider.sent).toHaveLength(1);
      });
    });

    describe("concurrency", () => {
      it("many workers and reconcilers acting on one pending send call the provider exactly once", async () => {
        provider.sending = sendingCapabilities();
        const { sendId } = await reply();
        await Promise.all([
          ...Array.from({ length: 6 }, () => run(sendId)),
          ...Array.from({ length: 4 }, () => reconcileOutboundEmail(deps())),
        ]);
        expect(provider.sendCalls).toBe(1);
        expect(provider.sent).toHaveLength(1);
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 1, retries: 0 });
      });

      it("concurrent recoverers of an expired attempt take it over once and record one decision", async () => {
        const { sendId } = await reply();
        await crashedClaim(sendId, MIN);
        advance(LEASE + MIN);
        const results = await Promise.all(
          Array.from({ length: 6 }, () => reconcileOutboundEmail(deps())),
        );
        expect(results.reduce((n, r) => n + r.recovered, 0)).toBe(1);
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 2,
          retries: 1,
        });
      });
    });

    describe("a worker that is paused or finishes late", () => {
      /** Holds the provider call open until `release()`, like a process frozen right before its request goes out. */
      function pauseProviderCall() {
        let release!: () => void;
        let markEntered!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        // Resolves when the worker has passed every check and is INSIDE the provider call: only then is it "frozen".
        const entered = new Promise<void>((resolve) => (markEntered = resolve));
        const original = provider.sendEmail.bind(provider);
        vi.spyOn(provider, "sendEmail").mockImplementationOnce(async (message, options) => {
          markEntered();
          await gate;
          return original(message, options);
        });
        return Object.assign(release, { entered });
      }

      it("idempotent provider: the paused worker's late request is refused by the provider and its finalize is refused by the fence", async () => {
        provider.sending = sendingCapabilities();
        const { sendId } = await reply();
        const release = pauseProviderCall();
        const stuck = run(sendId, { sendTimeoutMs: 60_000 }); // passes the lease checks, then freezes before the call
        await release.entered; // the worker is now inside the provider call
        advance(10 * MIN); // its lease expires while it is frozen
        await reconcileOutboundEmail(deps()); // recovery: nothing accepted -> retry
        expect(await row(sendId)).toMatchObject({
          status: "RETRY_SCHEDULED",
          attempts: 2,
          retries: 1,
        });
        advance(10 * MIN);
        await run(sendId); // a second worker delivers it
        expect((await row(sendId)).status).toBe("SENT");
        expect(provider.sent).toHaveLength(1);
        release(); // the frozen worker wakes up and sends its request
        await stuck;
        expect(provider.sent).toHaveLength(1); // idempotency: no second delivery
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 3, retries: 1 }); // claim 1, takeover 2, claim 3; the stale finalize (fence 1) changed nothing
        expect(total("stale")).toBe(1);
      });

      it("lookup-only provider: the platform records one outcome, and the residual duplicate risk of a long pause is explicit", async () => {
        const { sendId } = await reply();
        const release = pauseProviderCall();
        const stuck = run(sendId, { sendTimeoutMs: 60_000 });
        await release.entered; // the worker is now inside the provider call
        advance(15 * MIN); // beyond the (longer) lease this slower worker was granted
        await reconcileOutboundEmail(deps());
        expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
        advance(10 * MIN);
        await run(sendId);
        expect((await row(sendId)).status).toBe("SENT");
        release();
        await stuck;
        // What is guaranteed: exactly one SENT record, from the current attempt; the stale worker changed nothing.
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 3 });
        expect(total("stale")).toBe(1);
        // What is NOT guaranteed (documented in docs/email-outbound.md): a process frozen for longer than the lease
        // margin, with a provider that neither deduplicates nor can be told apart, can deliver a second copy.
        expect(provider.sent.length).toBeGreaterThanOrEqual(1);
      });

      it("a send that completes after its lease expired but BEFORE any takeover is recorded normally", async () => {
        provider.sending = sendingCapabilities();
        const { sendId } = await reply();
        const release = pauseProviderCall();
        const slow = run(sendId, { sendTimeoutMs: 60_000 });
        await release.entered; // the worker is now inside the provider call
        advance(10 * MIN); // expired, but the reconciler has not run yet
        release();
        await slow;
        expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 1 });
        expect((await reconcileOutboundEmail(deps())).recovered).toBe(0);
        expect(provider.sent).toHaveLength(1);
      });
    });

    describe("an unavailable lookup", () => {
      it("recovery with the lookup down leaves the send UNKNOWN: no resend, and a later re-check can resolve it", async () => {
        const { sendId } = await reply();
        await crashedClaim(sendId, MIN);
        provider.lookupUnavailable = true;
        advance(LEASE + MIN);
        await reconcileOutboundEmail(deps());
        expect(await row(sendId)).toMatchObject({ status: "UNKNOWN", retries: 0 });
        advance(12 * 60 * MIN); // still inside the lookup's 24-hour retention
        await reconcileOutboundEmail(deps());
        await run(sendId);
        expect(provider.sendCalls).toBe(0);
        provider.lookupUnavailable = false;
        const result = await recheckUnknown(await requireOrganizationContext(), sendId, deps());
        expect(result.outcome).toBe("no_record");
        expect((await row(sendId)).status).toBe("FAILED");
        expect(provider.sendCalls).toBe(0);
      });

      it("a lookup that comes back FOUND after being down resolves it as accepted, never resent", async () => {
        const { sendId } = await reply();
        provider.hangNextSend({ delivered: true });
        provider.lookupUnavailable = true;
        await run(sendId);
        expect((await row(sendId)).status).toBe("UNKNOWN");
        provider.lookupUnavailable = false;
        advance(LEASE + settleAfter());
        const result = await recheckUnknown(await requireOrganizationContext(), sendId, deps());
        expect(result.outcome).toBe("found");
        expect(await row(sendId)).toMatchObject({ status: "SENT" });
        expect(provider.sendCalls).toBe(1);
      });

      function settleAfter() {
        return 11 * MIN;
      }
    });

    describe("the queue is unavailable while the outbox holds due work", () => {
      it("the reply is recorded (the database is the truth), the failure is counted, and nothing is lost", async () => {
        const flaky = new FlakyQueue();
        setAutomationQueueForTesting(flaky);
        const { sendId, duplicate } = await reply();
        expect(duplicate).toBe(false);
        expect(await row(sendId)).toMatchObject({ status: "PENDING" });
        expect(total("wakeup_failed")).toBe(1);
        expect(flaky.jobs).toHaveLength(0);
      });

      it("the reconciler survives the outage, counts it, and re-queues everything when the queue returns", async () => {
        const flaky = new FlakyQueue();
        setAutomationQueueForTesting(flaky);
        const first = await reply();
        advance(MIN);
        const outage = await reconcileOutboundEmail(deps());
        expect(outage).toMatchObject({ wokenUp: 0 });
        expect(total("wakeup_failed")).toBeGreaterThanOrEqual(2);
        expect((await row(first.sendId)).status).toBe("PENDING");
        // Redis comes back: the next pass re-creates the wake-up, and the (real) handler delivers once.
        flaky.up = true;
        expect(await reconcileOutboundEmail(deps())).toMatchObject({ wokenUp: 1 });
        expect(flaky.jobs).toHaveLength(1);
        await run(first.sendId);
        await run(first.sendId); // the same wake-up delivered twice
        expect(await row(first.sendId)).toMatchObject({ status: "SENT" });
        expect(provider.sendCalls).toBe(1);
      });

      it("a queue that comes back late does not turn due work into duplicate sends", async () => {
        const flaky = new FlakyQueue();
        setAutomationQueueForTesting(flaky);
        const { sendId } = await reply();
        flaky.up = true;
        for (let i = 0; i < 3; i++) await reconcileOutboundEmail(deps());
        await Promise.all(flaky.jobs.map(() => run(sendId)));
        expect(provider.sendCalls).toBe(1);
        expect(provider.sent).toHaveLength(1);
      });
    });
  },
);
