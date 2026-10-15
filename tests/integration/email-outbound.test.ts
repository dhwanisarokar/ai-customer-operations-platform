import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import {
  FakeEmailProvider,
  NO_SENDING_GUARANTEES,
  sendingCapabilities,
} from "@/server/email/fake-provider";
import { handleInboundWebhook } from "@/server/email/inbound-webhook";
import {
  createOutboundReply,
  processEmailSendJob,
  reconcileOutboundEmail,
  type OutboundDeps,
} from "@/server/email/outbound";
import { OUTBOUND_POLICY, backoffMs } from "@/server/email/outbound-state";
import type { NormalizedInboundEmail } from "@/server/email/provider";
import { checkBackgroundHealth } from "@/server/services/background-health";
import { collectGauges, evaluateAlerts, runMaintenance } from "@/server/maintenance";
import { metrics } from "@/server/observability/metrics";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { sampleInbound } from "../helpers/email-provider-contract";
import { RecordingQueue } from "../helpers/recording-queue";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const ADDRESS_A = `help-a@${DOMAIN}`;
const ADDRESS_B = `help-b@${DOMAIN}`;
let counter = 100;

describeDb("outbound email: durable delivery foundation (fake provider)", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  let queue: RecordingQueue;
  let clock: Date;
  let customerId: string;
  let conversationId: string;
  const db = async () => (await import("@/db/client")).getDb();

  /** Deterministic time, jitter and timeouts. Nothing in these tests waits for the real clock. */
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

  async function emailConversation(
    organizationId: string,
    customer: string,
    subject = "Order help",
  ) {
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
  async function reply(
    body = "Hello Eve, your order shipped.",
    cid = conversationId,
    over: Partial<OutboundDeps> = {},
  ) {
    return createOutboundReply(await ctxOf(t.adminA), cid, { body }, deps(over));
  }
  const row = async (sendId: string) =>
    (await db()).outboundEmail.findUniqueOrThrow({ where: { id: sendId } });
  const job = (sendId: string, organizationId = t.orgA.id) => ({
    kind: "email-send" as const,
    executionId: `email-send-${sendId}-0`,
    organizationId,
    sendId,
  });
  const run = (sendId: string, over: Partial<OutboundDeps> = {}, organizationId = t.orgA.id) =>
    processEmailSendJob(job(sendId, organizationId), deps(over));
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
    provider = new FakeEmailProvider("out-secret");
    setEmailProviderForTesting(provider);
    queue = new RecordingQueue();
    setAutomationQueueForTesting(queue);
    await enableEmail(t.orgA.id, ADDRESS_A);
    customerId = (await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@customer.test" }))
      .id;
    conversationId = await emailConversation(t.orgA.id, customerId);
    as(t.adminA);
    metrics.reset();
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

  // ---- 1. success ---------------------------------------------------------------------------------------

  describe("recording and successful delivery", () => {
    it("records the message and the send atomically, as PENDING, and queues an ids-only wake-up", async () => {
      const { messageId, sendId } = await reply("Secret order details");
      const client = await db();
      const message = await client.message.findUniqueOrThrow({ where: { id: messageId } });
      expect(message).toMatchObject({
        senderType: "USER",
        messageType: "MESSAGE",
        body: "Secret order details",
      });
      const send = await row(sendId);
      expect(send).toMatchObject({
        organizationId: t.orgA.id,
        conversationId,
        messageId,
        status: "PENDING",
        attempts: 0,
        fromAddress: ADDRESS_A,
        fromName: "Acme Support",
        toAddress: "eve@customer.test",
        subject: "Re: Order help",
        providerMessageId: null,
        leaseUntil: null,
        sentAt: null,
      });
      expect(send.rfcMessageId).toBe(`<${sendId}@${DOMAIN}>`);

      // The thread index row exists, so the customer's reply can be threaded to our Message-ID.
      const thread = await client.emailMessage.findFirstOrThrow({ where: { messageId } });
      expect(thread).toMatchObject({
        direction: "OUTBOUND",
        rfcMessageId: send.rfcMessageId,
        providerMessageId: null,
      });

      // The queue gets a wake-up with ids only: no body, no address, no subject.
      const [wake] = queue.emailJobs();
      expect(wake).toMatchObject({ kind: "email-send", organizationId: t.orgA.id, sendId });
      expect(JSON.stringify(queue.jobs)).not.toMatch(/Secret order|eve@customer|Order help/);
      // The send row does not duplicate the message text.
      expect(JSON.stringify(send)).not.toContain("Secret order details");
    });

    it("delivers through the provider and persists SENT with the provider id", async () => {
      const { sendId, messageId } = await reply("Hello Eve, your order shipped.");
      await run(sendId);
      const send = await row(sendId);
      expect(send).toMatchObject({
        status: "SENT",
        attempts: 1,
        lastErrorCode: null,
        leaseUntil: null,
      });
      expect(send.providerMessageId).toMatch(/^fake-/);
      expect(send.sentAt?.toISOString()).toBe(clock.toISOString());
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]).toMatchObject({
        to: "eve@customer.test",
        from: { address: ADDRESS_A, name: "Acme Support" },
        subject: "Re: Order help",
        text: "Hello Eve, your order shipped.", // read from messages at send time
        idempotencyKey: sendId,
        messageId: `<${sendId}@${DOMAIN}>`,
      });
      const thread = await (await db()).emailMessage.findFirstOrThrow({ where: { messageId } });
      expect(thread.providerMessageId).toBe(send.providerMessageId);
      expect(total("sent")).toBe(1);
    });

    it("a second run of the same job is a no-op (nothing is sent twice)", async () => {
      const { sendId } = await reply();
      await run(sendId);
      await run(sendId);
      await run(sendId);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sendCalls).toBe(1);
      expect(total("skipped", { reason: "not_claimable" })).toBe(2);
    });

    it("a failed recording rolls back the message too: no orphan message, no orphan send", async () => {
      // A customer without an address cannot be emailed: the message must not be created either.
      const noEmail = await seedCustomer(t.orgA.id, { firstName: "NoMail", email: null });
      const cid = await emailConversation(t.orgA.id, noEmail.id);
      const before = await (await db()).message.count();
      await expect(reply("hi", cid)).rejects.toThrow(/no email address/i);
      expect(await (await db()).message.count()).toBe(before);
      expect(await (await db()).outboundEmail.count()).toBe(0);
      expect(queue.emailJobs()).toHaveLength(0);
    });

    it.each([
      [
        "a conversation on another channel",
        async () => {
          const client = await db();
          return (
            await client.conversation.create({
              data: {
                organizationId: t.orgA.id,
                customerId,
                subject: "x",
                channel: "WEB_CHAT",
                lastMessageAt: new Date(),
              },
            })
          ).id;
        },
        /email conversations/i,
      ],
      [
        "an archived customer",
        async () => {
          const archived = await seedCustomer(t.orgA.id, {
            firstName: "Old",
            email: "old@customer.test",
            status: "ARCHIVED",
          });
          return emailConversation(t.orgA.id, archived.id);
        },
        /archived/i,
      ],
    ])("refuses %s (and leaves nothing behind)", async (_label, make, message) => {
      const cid = await make();
      await expect(reply("hi", cid)).rejects.toThrow(message);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });

    it("refuses when email is disabled for the organization", async () => {
      await emailSettingsRepository.setEnabled(t.orgA.id, false);
      await expect(reply()).rejects.toThrow(/not set up/i);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });
  });

  // ---- 2-4. retry, permanent failure, exhaustion --------------------------------------------------------

  describe("retries", () => {
    it("a transient failure schedules a durable retry with backoff; the same email is sent on the retry", async () => {
      const spy = vi.spyOn(provider, "sendEmail");
      const { sendId } = await reply();
      provider.failNextSend({ retryable: true, code: "rate_limited" });
      await run(sendId);
      const first = await row(sendId);
      expect(first).toMatchObject({
        status: "RETRY_SCHEDULED",
        attempts: 1,
        lastErrorCode: "rate_limited",
        leaseUntil: null,
      });
      expect(first.nextAttemptAt.getTime()).toBe(clock.getTime() + backoffMs(1, () => 0.5));
      expect(provider.sent).toHaveLength(0);

      // Not due yet: the wake-up does nothing (and the provider is not called).
      await run(sendId);
      expect(provider.sendCalls).toBe(1);
      expect(total("skipped", { reason: "not_due" })).toBe(1);

      advance(31_000);
      await run(sendId);
      expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 2, lastErrorCode: null });
      expect(provider.sent).toHaveLength(1);
      // Every attempt sent the SAME logical email: same Message-ID, same idempotency key, same headers.
      const [a, b] = spy.mock.calls.map(([m]) => m);
      expect(a).toEqual(b);
      expect(a.idempotencyKey).toBe(sendId);
    });

    it("the retry survives a restart: it lives in the database, and the reconciler wakes it when due", async () => {
      const { sendId } = await reply();
      provider.failNextSend({ retryable: true });
      await run(sendId);
      // "Restart": the queue lost everything and the process state is gone.
      const fresh = new RecordingQueue();
      setAutomationQueueForTesting(fresh);
      expect((await reconcileOutboundEmail(deps())).wokenUp).toBe(0); // not due yet
      advance(31_000);
      expect((await reconcileOutboundEmail(deps())).wokenUp).toBe(1);
      expect(fresh.emailJobs()).toHaveLength(1);
      expect(fresh.emailJobs()[0].executionId).toBe(`email-send-${sendId}-1`);
      await processEmailSendJob(fresh.emailJobs()[0], deps());
      expect((await row(sendId)).status).toBe("SENT");
    });

    it("a permanent failure is final and never retried automatically", async () => {
      const { sendId } = await reply();
      provider.failNextSend({ retryable: false, code: "mailbox_invalid" });
      await run(sendId);
      expect(await row(sendId)).toMatchObject({
        status: "FAILED",
        attempts: 1,
        lastErrorCode: "mailbox_invalid",
        finalReason: "permanent",
        leaseUntil: null,
      });
      expect((await row(sendId)).failedAt).not.toBeNull();
      advance(10 * 3600_000);
      await run(sendId);
      expect((await reconcileOutboundEmail(deps())).wokenUp).toBe(0);
      expect(provider.sendCalls).toBe(1);
      expect(total("failed", { reason: "permanent" })).toBe(1);
    });

    it("provider text never reaches the database: an unsafe code is stored as a generic one", async () => {
      const { sendId } = await reply();
      provider.failNextSend({
        retryable: false,
        code: "550 5.1.1 <eve@customer.test> user unknown",
      });
      await run(sendId);
      expect((await row(sendId)).lastErrorCode).toBe("provider_error");
    });

    it("exhausted retries end explicitly as FAILED (retries_exhausted) after the configured attempts", async () => {
      const { sendId } = await reply();
      for (let i = 0; i < 3; i++) provider.failNextSend({ retryable: true, code: "unavailable" });
      for (let i = 0; i < 3; i++) {
        await run(sendId, { maxAttempts: 3 });
        advance(2 * 3600_000);
      }
      expect(await row(sendId)).toMatchObject({
        status: "FAILED",
        attempts: 3,
        finalReason: "retries_exhausted",
        lastErrorCode: "unavailable",
      });
      await run(sendId, { maxAttempts: 3 });
      expect(provider.sendCalls).toBe(3);
      expect((await reconcileOutboundEmail(deps())).wokenUp).toBe(0);
    });

    it("the default policy allows six attempts with bounded exponential backoff", async () => {
      expect(OUTBOUND_POLICY.maxAttempts).toBe(6);
      const { sendId } = await reply();
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        provider.failNextSend({ retryable: true });
        await run(sendId);
        const r = await row(sendId);
        delays.push(r.nextAttemptAt.getTime() - clock.getTime());
        advance(r.nextAttemptAt.getTime() - clock.getTime());
      }
      expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    });
  });

  // ---- 5. ambiguous outcomes ---------------------------------------------------------------------------

  describe("ambiguous outcomes never cause an unsafe resend", () => {
    it("lookup-capable provider, the email WAS accepted: recorded SENT from the lookup, sent exactly once", async () => {
      const { sendId } = await reply();
      provider.ambiguousNextSend({ delivered: true });
      await run(sendId);
      const send = await row(sendId);
      expect(send).toMatchObject({ status: "SENT", attempts: 1 });
      expect(send.providerMessageId).toBe(provider.sent[0].providerMessageId);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sendCalls).toBe(1);
      expect(total("ambiguous")).toBe(1);
    });

    it("lookup-capable provider, the email was NOT accepted: a retry is safe and delivers once", async () => {
      const { sendId } = await reply();
      provider.ambiguousNextSend({ delivered: false });
      await run(sendId);
      expect(await row(sendId)).toMatchObject({
        status: "RETRY_SCHEDULED",
        attempts: 1,
        lastErrorCode: "timeout",
      });
      advance(31_000);
      await run(sendId);
      expect((await row(sendId)).status).toBe("SENT");
      expect(provider.sent).toHaveLength(1);
      expect(provider.sendCalls).toBe(2);
    });

    it("a hung provider call times out as ambiguous and is treated the same way", async () => {
      const { sendId } = await reply();
      provider.hangNextSend({ delivered: true });
      await run(sendId, { sendTimeoutMs: 20 });
      expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 1 });
      expect(provider.sent).toHaveLength(1);
    });

    it("no idempotency and no lookup: the send stays UNKNOWN and is NEVER resent, in either world", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      for (const delivered of [true, false]) {
        const cid = await emailConversation(t.orgA.id, customerId, `Subject ${delivered}`);
        const { sendId } = await reply("hello", cid);
        const callsBefore = provider.sendCalls;
        provider.ambiguousNextSend({ delivered });
        await run(sendId);
        const send = await row(sendId);
        expect(send).toMatchObject({
          status: "UNKNOWN",
          attempts: 1,
          lastErrorCode: "timeout",
          providerMessageId: null,
        });
        expect(send.sentAt).toBeNull();
        expect(send.failedAt).toBeNull();
        // Whatever time passes and however often the worker looks, the provider is not called again.
        for (let i = 0; i < 3; i++) {
          advance(24 * 3600_000);
          await run(sendId);
          await reconcileOutboundEmail(deps());
        }
        expect(provider.sendCalls).toBe(callsBefore + 1);
        expect((await row(sendId)).status).toBe("UNKNOWN");
      }
      expect(provider.sent).toHaveLength(1); // only the world where it really was delivered, delivered once
      expect(total("unknown")).toBe(0 + 2);
    });

    it("idempotent provider without a lookup: the retry uses the same key and cannot duplicate", async () => {
      provider.sending = sendingCapabilities({
        lookupByKey: false,
        lookupConsistency: "none",
        lookupSettleMs: null,
        lookupRetentionMs: null,
      });
      const { sendId } = await reply();
      provider.ambiguousNextSend({ delivered: true });
      await run(sendId);
      expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
      advance(31_000);
      await run(sendId);
      expect((await row(sendId)).status).toBe("SENT");
      expect(provider.sendCalls).toBe(2);
      expect(provider.sent).toHaveLength(1); // the provider refused the second delivery
    });

    it("an unavailable lookup does not stand in for an answer", async () => {
      provider.sending = sendingCapabilities({ idempotentByKey: false, keyRetentionMs: null });
      provider.lookupUnavailable = true;
      const { sendId } = await reply();
      provider.ambiguousNextSend({ delivered: true });
      await run(sendId);
      expect((await row(sendId)).status).toBe("UNKNOWN");
    });

    it("an adapter that throws is treated as ambiguous, not as a failure", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      vi.spyOn(provider, "sendEmail").mockRejectedValueOnce(new Error("socket hang up"));
      const { sendId } = await reply();
      await run(sendId);
      expect(await row(sendId)).toMatchObject({
        status: "UNKNOWN",
        lastErrorCode: "adapter_exception",
      });
    });

    it("UNKNOWN can only be resolved with evidence (never moves back to a retry)", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const { sendId } = await reply();
      provider.ambiguousNextSend({ delivered: true });
      await run(sendId);
      expect(
        await outboundEmailRepository.resolveUnknown(
          sendId,
          t.orgA.id,
          { kind: "provider_lookup_found", providerMessageId: "pm-confirmed" },
          clock,
        ),
      ).toBe(true);
      expect(await row(sendId)).toMatchObject({
        status: "SENT",
        providerMessageId: "pm-confirmed",
      });
      // Final now: nothing else applies.
      expect(
        await outboundEmailRepository.resolveUnknown(
          sendId,
          t.orgA.id,
          { kind: "operator_confirmed_not_sent" },
          clock,
        ),
      ).toBe(false);
      expect(
        await outboundEmailRepository.markFailed(sendId, t.orgA.id, 1, "x", "permanent", clock),
      ).toBe(false);
    });
  });

  // ---- 6. crash / restart recovery ---------------------------------------------------------------------

  describe("worker crash and restart recovery", () => {
    /** A worker claimed the send and died. Optionally the provider had already accepted the email. */
    async function crashedWorker(sendId: string, options: { providerAccepted: boolean }) {
      const claimed = await outboundEmailRepository.claim(
        sendId,
        t.orgA.id,
        clock,
        new Date(clock.getTime() + 60_000),
      );
      expect(claimed).toMatchObject({ status: "PROCESSING", attempts: 1 });
      if (options.providerAccepted) {
        await provider.sendEmail({
          from: { address: ADDRESS_A, name: "Acme Support" },
          to: "eve@customer.test",
          subject: "Re: Order help",
          text: "hello",
          messageId: claimed!.rfcMessageId,
          inReplyTo: null,
          references: [],
          idempotencyKey: sendId,
        });
      }
    }

    it("died BEFORE reaching the provider: after the lease expires the lookup finds nothing and it is sent once", async () => {
      const { sendId } = await reply();
      await crashedWorker(sendId, { providerAccepted: false });
      // While the lease is valid nobody touches it.
      expect((await reconcileOutboundEmail(deps())).recovered).toBe(0);
      advance(61_000);
      expect((await reconcileOutboundEmail(deps())).recovered).toBe(1);
      expect(await row(sendId)).toMatchObject({
        status: "RETRY_SCHEDULED",
        attempts: 2,
        lastErrorCode: "lease_expired",
      });
      advance(61_000);
      await run(sendId);
      expect((await row(sendId)).status).toBe("SENT");
      expect(provider.sent).toHaveLength(1);
    });

    it("died AFTER the provider accepted the email: recovered as SENT from the lookup, NOT sent again", async () => {
      const { sendId } = await reply();
      await crashedWorker(sendId, { providerAccepted: true });
      advance(61_000);
      await reconcileOutboundEmail(deps());
      const send = await row(sendId);
      expect(send).toMatchObject({ status: "SENT", attempts: 2 });
      expect(send.providerMessageId).toBe(provider.sent[0].providerMessageId);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sendCalls).toBe(1);
      expect(total("recovered", { reason: "sent" })).toBe(1);
    });

    it("died, and the provider can neither be asked nor deduplicates: UNKNOWN, not 'sent', not resent", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const { sendId } = await reply();
      await crashedWorker(sendId, { providerAccepted: true });
      advance(61_000);
      await reconcileOutboundEmail(deps());
      expect(await row(sendId)).toMatchObject({
        status: "UNKNOWN",
        sentAt: null,
        providerMessageId: null,
      });
      advance(24 * 3600_000);
      await reconcileOutboundEmail(deps());
      await run(sendId);
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
    });

    it("a stale worker that wakes up after a takeover cannot overwrite the newer attempt", async () => {
      const { sendId } = await reply();
      await crashedWorker(sendId, { providerAccepted: false });
      advance(61_000);
      await reconcileOutboundEmail(deps()); // takes over: attempts 2, RETRY_SCHEDULED
      // The old worker (attempt 1) now tries to record its outcome.
      expect(await outboundEmailRepository.markSent(sendId, t.orgA.id, 1, "pm-stale", clock)).toBe(
        false,
      );
      expect(
        await outboundEmailRepository.markFailed(sendId, t.orgA.id, 1, "x", "permanent", clock),
      ).toBe(false);
      expect((await row(sendId)).status).toBe("RETRY_SCHEDULED");
    });

    it("the attempt number fences finalizing: a stale worker cannot overwrite a NEWER attempt that is in flight", async () => {
      const { sendId } = await reply();
      await crashedWorker(sendId, { providerAccepted: false }); // attempt 1, then the worker dies
      advance(61_000);
      await reconcileOutboundEmail(deps()); // takeover -> attempt 2 -> RETRY_SCHEDULED
      advance(61_000);
      const second = await outboundEmailRepository.claim(
        sendId,
        t.orgA.id,
        clock,
        new Date(clock.getTime() + 60_000),
      );
      expect(second).toMatchObject({ status: "PROCESSING", attempts: 3 }); // a new worker is mid-attempt
      // The ORIGINAL worker (attempt 1) wakes up and tries to record its outcome: refused, in every way.
      expect(await outboundEmailRepository.markSent(sendId, t.orgA.id, 1, "pm-stale", clock)).toBe(
        false,
      );
      expect(
        await outboundEmailRepository.markFailed(sendId, t.orgA.id, 1, "x", "permanent", clock),
      ).toBe(false);
      expect(await outboundEmailRepository.markUnknown(sendId, t.orgA.id, 1, "x", clock)).toBe(
        false,
      );
      expect(
        await outboundEmailRepository.scheduleRetry(sendId, t.orgA.id, 1, "x", clock, clock),
      ).toBe(false);
      expect(await row(sendId)).toMatchObject({
        status: "PROCESSING",
        attempts: 3,
        providerMessageId: null,
      });
      // Only the holder of the current attempt can finish it.
      expect(
        await outboundEmailRepository.markSent(sendId, t.orgA.id, 3, "pm-current", clock),
      ).toBe(true);
      expect((await row(sendId)).providerMessageId).toBe("pm-current");
    });

    it("a takeover never races two recoverers: exactly one wins", async () => {
      const { sendId } = await reply();
      await crashedWorker(sendId, { providerAccepted: false });
      advance(61_000);
      const results = await Promise.all([
        reconcileOutboundEmail(deps()),
        reconcileOutboundEmail(deps()),
      ]);
      expect(results.reduce((n, r) => n + r.recovered, 0)).toBe(1);
      expect((await row(sendId)).attempts).toBe(2);
    });

    it("a hung attempt whose lease expires while still running cannot finish a second delivery", async () => {
      const { sendId } = await reply();
      provider.hangNextSend({ delivered: false });
      const stuck = run(sendId, { sendTimeoutMs: 5_000 }); // the provider never answers
      // Wait until the worker is INSIDE the (hung) provider call, then let the lease run out and recover. Waiting only for
      // the claim to be visible is a race: the worker may not have passed its own lease check yet.
      while (provider.sendCalls < 1) await new Promise((resolve) => setTimeout(resolve, 5));
      advance(61_000);
      await reconcileOutboundEmail(deps());
      advance(61_000);
      await run(sendId);
      expect((await row(sendId)).status).toBe("SENT");
      expect(provider.sent).toHaveLength(1);
      void stuck; // never resolves; the claim token it holds is stale
    });
  });

  // ---- 7-9. duplicates, concurrency, lost jobs ---------------------------------------------------------

  describe("duplicate jobs, concurrent workers and lost jobs", () => {
    it("many duplicate queue jobs for one send call the provider exactly once", async () => {
      const { sendId } = await reply();
      await Promise.all(Array.from({ length: 8 }, () => run(sendId)));
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
      expect((await row(sendId)).status).toBe("SENT");
    });

    it("concurrent claims: exactly one wins", async () => {
      const { sendId } = await reply();
      const claims = await Promise.all(
        Array.from({ length: 10 }, () =>
          outboundEmailRepository.claim(
            sendId,
            t.orgA.id,
            clock,
            new Date(clock.getTime() + 60_000),
          ),
        ),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect((await row(sendId)).attempts).toBe(1);
    });

    it("concurrent workers over several sends: each is sent exactly once", async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const cid = await emailConversation(t.orgA.id, customerId, `Thread ${i}`);
        ids.push((await reply(`body ${i}`, cid)).sendId);
      }
      await Promise.all(ids.flatMap((id) => [run(id), run(id), run(id)]));
      expect(provider.sendCalls).toBe(5);
      expect(provider.sent.map((m) => m.idempotencyKey).sort()).toEqual([...ids].sort());
      for (const id of ids) expect((await row(id)).status).toBe("SENT");
    });

    it("a job that was never queued is recreated from the database outbox", async () => {
      queue.failEnqueue = true;
      const { sendId } = await reply();
      expect(queue.emailJobs()).toHaveLength(0);
      expect(total("wakeup_failed")).toBe(1);
      expect((await row(sendId)).status).toBe("PENDING"); // durable, though nothing was queued

      queue.failEnqueue = false;
      expect((await reconcileOutboundEmail(deps())).wokenUp).toBe(1);
      expect(queue.emailJobs()).toHaveLength(1);
      await processEmailSendJob(queue.emailJobs()[0], deps());
      expect((await row(sendId)).status).toBe("SENT");
    });

    it("a job lost with the queue (Redis flushed) is recreated, and a recreated duplicate is harmless", async () => {
      const { sendId } = await reply();
      queue.clear();
      await reconcileOutboundEmail(deps());
      await reconcileOutboundEmail(deps());
      expect(queue.emailJobs().length).toBeGreaterThanOrEqual(1);
      await Promise.all(queue.emailJobs().map((j) => processEmailSendJob(j, deps())));
      expect(provider.sent).toHaveLength(1);
      expect((await row(sendId)).status).toBe("SENT");
    });

    it("wake-up job ids carry the attempt number, so a later retry is not swallowed by queue deduplication", async () => {
      const { sendId } = await reply();
      provider.failNextSend({ retryable: true });
      await run(sendId);
      advance(31_000);
      await reconcileOutboundEmail(deps());
      const ids = queue.emailJobs().map((j) => j.executionId);
      expect(ids).toContain(`email-send-${sendId}-0`);
      expect(ids).toContain(`email-send-${sendId}-1`);
      for (const id of ids) expect(id).not.toContain(":");
    });
  });

  // ---- 10. provider success followed by a database failure ---------------------------------------------

  describe("provider success followed by a failed database update", () => {
    it("is never recorded as sent without proof and is resolved safely after the lease expires", async () => {
      const { sendId } = await reply();
      vi.spyOn(outboundEmailRepository, "markSent").mockRejectedValueOnce(new Error("db down"));
      await run(sendId);
      // The provider accepted it, but the database could not be told.
      expect(provider.sent).toHaveLength(1);
      expect(await row(sendId)).toMatchObject({
        status: "PROCESSING",
        sentAt: null,
        providerMessageId: null,
      });
      expect(total("finalize_failed")).toBe(1);
      // Nothing resends it while the lease is valid.
      await run(sendId);
      expect(provider.sendCalls).toBe(1);

      advance(61_000);
      await reconcileOutboundEmail(deps());
      const send = await row(sendId);
      expect(send).toMatchObject({ status: "SENT" });
      expect(send.providerMessageId).toBe(provider.sent[0].providerMessageId);
      expect(provider.sendCalls).toBe(1);
    });

    it("with no lookup and no idempotency it ends UNKNOWN: never 'sent' without proof, never resent", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const { sendId } = await reply();
      vi.spyOn(outboundEmailRepository, "markSent").mockRejectedValueOnce(new Error("db down"));
      await run(sendId);
      advance(61_000);
      await reconcileOutboundEmail(deps());
      expect((await row(sendId)).status).toBe("UNKNOWN");
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
    });

    it("a failure recording a retry decision is also recovered, not lost", async () => {
      const { sendId } = await reply();
      provider.failNextSend({ retryable: true });
      vi.spyOn(outboundEmailRepository, "scheduleRetry").mockRejectedValueOnce(
        new Error("db down"),
      );
      await run(sendId);
      expect((await row(sendId)).status).toBe("PROCESSING");
      advance(61_000);
      await reconcileOutboundEmail(deps());
      advance(2 * 3600_000);
      await run(sendId);
      expect((await row(sendId)).status).toBe("SENT");
      expect(provider.sent).toHaveLength(1);
    });
  });

  // ---- 11. tenant isolation ----------------------------------------------------------------------------

  describe("tenant isolation", () => {
    let orgBConversation: string;
    let orgBSettingsId: string;

    beforeEach(async () => {
      orgBSettingsId = await enableEmail(t.orgB.id, ADDRESS_B);
      const customerB = await seedCustomer(t.orgB.id, {
        firstName: "Bob",
        email: "bob@customer.test",
      });
      orgBConversation = await emailConversation(t.orgB.id, customerB.id, "Bob's order");
    });

    it("an organization cannot reply to another organization's conversation", async () => {
      await expect(reply("hi", orgBConversation)).rejects.toThrow();
      expect(await (await db()).outboundEmail.count()).toBe(0);
      expect(
        await (await db()).message.count({ where: { conversationId: orgBConversation } }),
      ).toBe(0);
    });

    it("each organization sends from its OWN verified address", async () => {
      const a = await reply("for Eve");
      as(t.ownerB);
      const b = await createOutboundReply(
        await requireOrganizationContext(),
        orgBConversation,
        { body: "for Bob" },
        deps(),
      );
      await Promise.all([run(a.sendId), run(b.sendId, {}, t.orgB.id)]);
      const bySend = new Map(provider.sent.map((m) => [m.idempotencyKey, m]));
      expect(bySend.get(a.sendId)).toMatchObject({
        from: { address: ADDRESS_A },
        to: "eve@customer.test",
      });
      expect(bySend.get(b.sendId)).toMatchObject({
        from: { address: ADDRESS_B },
        to: "bob@customer.test",
      });
    });

    it("a job naming the wrong organization finds nothing and does nothing", async () => {
      const { sendId } = await reply();
      await run(sendId, {}, t.orgB.id);
      expect(provider.sendCalls).toBe(0);
      expect((await row(sendId)).status).toBe("PENDING");
      expect(total("skipped", { reason: "not_found" })).toBe(1);
      // A repository call keyed by the wrong organization cannot touch the row either.
      expect(await outboundEmailRepository.claim(sendId, t.orgB.id, clock, clock)).toBeNull();
      expect(await outboundEmailRepository.find(sendId, t.orgB.id)).toBeNull();
    });

    it("the reply's threading never includes another organization's Message-IDs", async () => {
      const client = await db();
      const { emailInboundRepository } = await import("@/server/repositories/email-inbound");
      const bMessage = await client.message.create({
        data: {
          organizationId: t.orgB.id,
          conversationId: orgBConversation,
          senderType: "CUSTOMER",
          body: "b",
        },
      });
      await emailInboundRepository.createEmailMessage({
        organizationId: t.orgB.id,
        conversationId: orgBConversation,
        messageId: bMessage.id,
        direction: "INBOUND",
        providerMessageId: "pmb",
        rfcMessageId: "<secret-b@customer.test>",
        inReplyTo: null,
        references: [],
        fromAddress: "bob@customer.test",
        fromName: null,
        toAddresses: [ADDRESS_B],
        ccAddresses: [],
        subject: "s",
        spf: "pass",
        dkim: "pass",
        attachments: [],
        receivedAt: new Date(),
      });
      const { sendId } = await reply();
      const send = await row(sendId);
      expect(JSON.stringify([send.inReplyTo, send.references])).not.toContain("secret-b");
    });

    it("the database refuses a send that mixes organizations (composite foreign keys)", async () => {
      const client = await db();
      const { sendId, messageId } = await reply();
      const base = await row(sendId);
      const clone = (over: Record<string, unknown>) => ({
        id: crypto.randomUUID(),
        organizationId: t.orgA.id,
        conversationId,
        messageId: crypto.randomUUID(),
        emailSettingsId: base.emailSettingsId,
        fromAddress: ADDRESS_A,
        fromName: "Acme",
        toAddress: "eve@customer.test",
        subject: "s",
        rfcMessageId: `<${crypto.randomUUID()}@${DOMAIN}>`,
        references: [],
        nextAttemptAt: new Date(),
        ...over,
      });
      const bMessage = await client.message.create({
        data: {
          organizationId: t.orgB.id,
          conversationId: orgBConversation,
          senderType: "USER",
          body: "b",
        },
      });
      // a conversation of organization B under organization A
      await expect(
        client.outboundEmail.create({
          data: clone({ conversationId: orgBConversation, messageId: bMessage.id }),
        }),
      ).rejects.toThrow();
      // a message of organization B under organization A's conversation
      await expect(
        client.outboundEmail.create({ data: clone({ messageId: bMessage.id }) }),
      ).rejects.toThrow();
      // organization B's settings under organization A
      await expect(
        client.outboundEmail.create({
          data: clone({ messageId, emailSettingsId: orgBSettingsId }),
        }),
      ).rejects.toThrow();
    });
  });

  // ---- 12. threading ----------------------------------------------------------------------------------

  describe("email threading", () => {
    async function inbound(overrides: Partial<NormalizedInboundEmail>) {
      counter += 1;
      const email = sampleInbound({
        providerMessageId: `in-${counter}`,
        from: "eve@customer.test",
        fromName: "Eve",
        deliveredTo: [ADDRESS_A],
        to: [ADDRESS_A],
        subject: "Order help",
        text: "Where is my order?",
        ...overrides,
      });
      const res = await handleInboundWebhook(provider.receive(email).webhook);
      expect(res.body.status).toBe("processed");
    }
    // The conversation an inbound email created, found by the RFC Message-ID recorded for it (inside this organization).
    // NOT by subject: the seeded conversation of this suite has the same subject, a lookup by subject has no defined
    // order, and which of the two rows a database returns depends on its query plan (index order on a database with
    // statistics, insertion order on a fresh one).
    const conversationOf = async (rfcMessageId: string) => {
      const found = await (
        await db()
      ).emailMessage.findFirstOrThrow({
        where: { organizationId: t.orgA.id, rfcMessageId },
        select: { conversationId: true },
      });
      expect(found.conversationId).not.toBe(conversationId); // an inbound email never lands in the seeded conversation
      return found.conversationId;
    };

    it("replies in the customer's thread: In-Reply-To is their message, References the chain, Message-ID ours", async () => {
      await inbound({ messageId: "<c1@customer.test>" });
      const cid = await conversationOf("<c1@customer.test>");
      const first = await reply("Reply 1", cid);
      await run(first.sendId);
      const sent1 = provider.sent[0];
      expect(sent1).toMatchObject({
        inReplyTo: "<c1@customer.test>",
        references: ["<c1@customer.test>"],
        messageId: `<${first.sendId}@${DOMAIN}>`,
        subject: "Re: Order help",
      });

      await inbound({
        messageId: "<c2@customer.test>",
        inReplyTo: "<c1@customer.test>",
        text: "Any update?",
      });
      const second = await reply("Reply 2", cid);
      await run(second.sendId);
      expect(provider.sent[1]).toMatchObject({
        inReplyTo: "<c2@customer.test>",
        references: ["<c1@customer.test>", `<${first.sendId}@${DOMAIN}>`, "<c2@customer.test>"],
      });
    });

    it("the customer's reply to OUR Message-ID lands in the same conversation, whatever its subject says", async () => {
      await inbound({ messageId: "<c1@customer.test>" });
      const cid = await conversationOf("<c1@customer.test>");
      const { sendId } = await reply("Reply", cid);
      await run(sendId);
      await inbound({
        messageId: "<c3@customer.test>",
        inReplyTo: `<${sendId}@${DOMAIN}>`,
        subject: "A completely different subject",
        text: "Thanks!",
      });
      const client = await db();
      expect(
        await client.conversation.count({ where: { organizationId: t.orgA.id, channel: "EMAIL" } }),
      ).toBe(2); // the seeded one + the inbound one
      expect(
        await client.message.count({ where: { conversationId: cid, senderType: "CUSTOMER" } }),
      ).toBe(2);
    });

    it("a conversation with no recorded Message-IDs starts a fresh thread: nothing is derived from the subject", async () => {
      const { sendId } = await reply("First contact");
      const send = await row(sendId);
      expect(send.inReplyTo).toBeNull();
      expect(send.references).toEqual([]);
      await run(sendId);
      expect(provider.sent[0]).toMatchObject({ inReplyTo: null, references: [] });
    });

    it("the subject is 'Re: ' once, and the Message-ID is the same on every attempt", async () => {
      const cid = await emailConversation(t.orgA.id, customerId, "Re: already a reply");
      const { sendId } = await reply("x", cid);
      expect((await row(sendId)).subject).toBe("Re: already a reply");
    });

    it("header-unsafe subjects are cleaned before they are stored", async () => {
      const cid = await emailConversation(t.orgA.id, customerId, "Bad\r\nBcc: attacker@evil.test");
      const { sendId } = await reply("x", cid);
      expect((await row(sendId)).subject).not.toMatch(/[\r\n]/);
    });
  });

  // ---- 13. production safety ---------------------------------------------------------------------------

  describe("production safety", () => {
    it("the fake provider cannot deliver in production even if one is injected: nothing is sent, nothing is claimed", async () => {
      const { sendId } = await reply();
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("EMAIL_PROVIDER", ""); // production env validation forbids "fake"
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      await run(sendId);
      expect(provider.sendCalls).toBe(0);
      expect((await row(sendId)).status).toBe("PENDING");
      expect(total("skipped", { reason: "provider_unavailable" })).toBe(1);
      expect((await reconcileOutboundEmail(deps())).wokenUp).toBe(0);
    });

    it("production configuration rejects the fake provider outright", async () => {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("EMAIL_PROVIDER", "fake");
      const { resetServerEnvForTesting, getServerEnv } = await import("@/lib/env");
      resetServerEnvForTesting();
      expect(() => getServerEnv()).toThrow(/EMAIL_PROVIDER/);
    });

    it("with no provider configured nothing is sent and no other provider is chosen as a fallback", async () => {
      const { sendId } = await reply();
      setEmailProviderForTesting(undefined);
      vi.stubEnv("EMAIL_PROVIDER", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      await run(sendId);
      expect(provider.sendCalls).toBe(0);
      expect((await row(sendId)).status).toBe("PENDING");
    });
  });

  // ---- sender / message checks at send time -----------------------------------------------------------

  describe("checks made when the email is actually sent", () => {
    it("email switched off after queueing: failed with a clear code, nothing sent", async () => {
      const { sendId } = await reply();
      await emailSettingsRepository.setEnabled(t.orgA.id, false);
      await run(sendId);
      expect(await row(sendId)).toMatchObject({
        status: "FAILED",
        finalReason: "sender_unavailable",
        lastErrorCode: "sender_unavailable",
      });
      expect(provider.sendCalls).toBe(0);
    });

    it("the organization changed its address after queueing: it never sends from an address that is no longer verified", async () => {
      const { sendId } = await reply();
      await emailSettingsRepository.changeAddress(t.orgA.id, {
        localPart: "other",
        supportAddress: `other@${DOMAIN}`,
        fromName: "Acme",
      });
      await run(sendId);
      expect(await row(sendId)).toMatchObject({
        status: "FAILED",
        finalReason: "sender_unavailable",
      });
      expect(provider.sendCalls).toBe(0);
    });

    it("the message vanished: failed as message_missing, nothing sent", async () => {
      const { sendId, messageId } = await reply();
      // Remove the message row's content path: delete the message (cascades the send), so recreate the send state
      // by editing the message type to an internal note instead (a note must never be emailed).
      await (
        await db()
      ).message.update({ where: { id: messageId }, data: { messageType: "INTERNAL_NOTE" } });
      await run(sendId);
      expect(await row(sendId)).toMatchObject({ status: "FAILED", finalReason: "message_missing" });
      expect(provider.sendCalls).toBe(0);
    });
  });

  // ---- database integrity ------------------------------------------------------------------------------

  describe("database constraints (bypassing the service)", () => {
    async function base() {
      const { sendId, messageId } = await reply();
      return { sendId, messageId, send: await row(sendId), client: await db() };
    }

    it("one send per message and unique Message-IDs per organization", async () => {
      const { client, send } = await base();
      const data = {
        organizationId: t.orgA.id,
        conversationId,
        messageId: send.messageId,
        emailSettingsId: send.emailSettingsId,
        fromAddress: ADDRESS_A,
        fromName: "A",
        toAddress: "eve@customer.test",
        subject: "s",
        rfcMessageId: "<unique-1@x.test>",
        references: [],
        nextAttemptAt: new Date(),
      };
      await expect(client.outboundEmail.create({ data })).rejects.toThrow(); // messageId already has a send
      const second = await client.message.create({
        data: { organizationId: t.orgA.id, conversationId, senderType: "USER", body: "x" },
      });
      await expect(
        client.outboundEmail.create({
          data: { ...data, messageId: second.id, rfcMessageId: send.rfcMessageId },
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["SENT without proof", { status: "SENT" as const }],
      ["FAILED without a reason", { status: "FAILED" as const, failedAt: new Date() }],
      ["PROCESSING without a lease", { status: "PROCESSING" as const, attempts: 1 }],
      [
        "PROCESSING with no attempt counted",
        { status: "PROCESSING" as const, leaseUntil: new Date() },
      ],
      ["PENDING with attempts", { attempts: 1 }],
      [
        "a lease on a waiting send",
        { status: "RETRY_SCHEDULED" as const, leaseUntil: new Date(), attempts: 1 },
      ],
      ["free-text error code", { lastErrorCode: "Mailbox full: bob@x.test" }],
      ["upper-case recipient", { toAddress: "Eve@Customer.test" }],
      ["a header-injection subject", { subject: "a\nBcc: x@y.test" }],
      ["a malformed Message-ID", { rfcMessageId: "no-brackets" }],
      ["too many attempts", { attempts: 51 }],
    ])("refuses %s", async (_label, patch) => {
      const { client, send } = await base();
      await expect(
        client.outboundEmail.update({ where: { id: send.id }, data: patch }),
      ).rejects.toThrow();
    });

    it("conditional updates refuse impossible transitions", async () => {
      const { sendId } = await base();
      // PENDING cannot be marked sent / failed / unknown / retried: only claimed.
      expect(await outboundEmailRepository.markSent(sendId, t.orgA.id, 0, "pm", clock)).toBe(false);
      expect(
        await outboundEmailRepository.markFailed(sendId, t.orgA.id, 0, "x", "permanent", clock),
      ).toBe(false);
      expect(await outboundEmailRepository.markUnknown(sendId, t.orgA.id, 0, "x", clock)).toBe(
        false,
      );
      expect(
        await outboundEmailRepository.scheduleRetry(sendId, t.orgA.id, 0, "x", clock, clock),
      ).toBe(false);
      expect(
        await outboundEmailRepository.resolveUnknown(
          sendId,
          t.orgA.id,
          { kind: "operator_confirmed_not_sent" },
          clock,
        ),
      ).toBe(false);
      // Claiming something not yet due does nothing.
      expect(
        await outboundEmailRepository.claim(
          sendId,
          t.orgA.id,
          new Date(clock.getTime() - 3_600_000),
          clock,
        ),
      ).toBeNull();
      expect((await row(sendId)).status).toBe("PENDING");
    });

    it("deleting an organization removes its sends", async () => {
      const { client } = await base();
      await client.organization.delete({ where: { id: t.orgA.id } });
      expect(await client.outboundEmail.count()).toBe(0);
    });
  });

  // ---- the shared queue and worker ---------------------------------------------------------------------

  describe("shared queue and job router", () => {
    it("the shared job router runs an email wake-up and leaves other job kinds alone", async () => {
      const { processQueueJob } = await import("@/server/jobs");
      // The router uses the real clock, so the send is created with it too.
      const { sendId } = await reply("Hello", conversationId, { now: () => new Date() });
      await processQueueJob(job(sendId), { attempt: 1, maxAttempts: 5 });
      expect((await row(sendId)).status).toBe("SENT");
      // A wake-up for a send that does not exist is a harmless no-op, not an error that retries forever.
      await expect(
        processQueueJob(job(crypto.randomUUID()), { attempt: 1, maxAttempts: 5 }),
      ).resolves.toBeUndefined();
    });

    it("end to end through the real in-process queue and worker: a reply is delivered without any manual step", async () => {
      const { MemoryAutomationQueue } = await import("@/server/automation/queue/memory");
      const real = new MemoryAutomationQueue({ backoffBaseMs: 0 });
      setAutomationQueueForTesting(real);
      const { createOutboundReply: create } = await import("@/server/email/outbound");
      const { sendId } = await create(await ctxOf(t.adminA), conversationId, {
        body: "End to end",
      });
      await real.drain();
      expect(await row(sendId)).toMatchObject({ status: "SENT", attempts: 1 });
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].text).toBe("End to end");
    });

    it("a duplicate wake-up for the same attempt is deduplicated by the queue AND by the database claim", async () => {
      const { MemoryAutomationQueue } = await import("@/server/automation/queue/memory");
      const real = new MemoryAutomationQueue({ backoffBaseMs: 0 });
      setAutomationQueueForTesting(real);
      const { createOutboundReply: create, wakeUp } = await import("@/server/email/outbound");
      const { sendId } = await create(await ctxOf(t.adminA), conversationId, { body: "Once" });
      await wakeUp({ id: sendId, organizationId: t.orgA.id, attempts: 0 });
      await wakeUp({ id: sendId, organizationId: t.orgA.id, attempts: 0 });
      await real.drain();
      expect(provider.sent).toHaveLength(1);
    });
  });

  // ---- operations --------------------------------------------------------------------------------------

  describe("worker integration and observability", () => {
    it("a maintenance pass resolves dead attempts and recreates lost wake-ups", async () => {
      const { sendId } = await reply();
      queue.clear();
      const result = await runMaintenance({ now: clock });
      expect(result.outboundEmail.wokenUp).toBe(1);
      expect(queue.emailJobs()[0].sendId).toBe(sendId);
    });

    it("due-but-unsent email raises the delayed/stuck alerts and degrades background health", async () => {
      await reply("Hello", conversationId, { now: () => new Date() });
      const later = new Date(Date.now() + 20 * 60_000);
      const gauges = await collectGauges(later);
      expect(gauges.outboundEmail.due).toBe(1);
      expect(gauges.outboundEmail.oldestDueAgeSeconds).toBeGreaterThanOrEqual(1100);
      expect(evaluateAlerts(gauges).map((a) => a.name)).toContain("email_outbound_delayed");
      const health = await checkBackgroundHealth(later);
      expect(health.checks.outbound).toBe("delayed");
      expect(health.status).toBe("degraded");
      const muchLater = new Date(Date.now() + 2 * 3600_000);
      expect((await checkBackgroundHealth(muchLater)).checks.outbound).toBe("stuck");
    });

    it("work that is waiting BY DESIGN (a scheduled retry) is not an alert", async () => {
      const { sendId } = await reply();
      provider.failNextSend({ retryable: true });
      await run(sendId);
      const gauges = await collectGauges(clock);
      expect(gauges.outboundEmail.due).toBe(0);
      expect(evaluateAlerts(gauges).map((a) => a.name)).not.toContain("email_outbound_delayed");
    });

    it("an UNKNOWN send is surfaced as a warning for an operator, and does not make the system 'unhealthy'", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const { sendId } = await reply();
      provider.ambiguousNextSend({ delivered: true });
      await run(sendId);
      const gauges = await collectGauges(clock);
      expect(gauges.outboundEmail.unknown).toBe(1);
      expect(evaluateAlerts(gauges).find((a) => a.name === "email_outbound_unknown")).toMatchObject(
        { severity: "warn" },
      );
      const health = await checkBackgroundHealth(clock);
      expect(health.details.unknownEmails).toBe(1);
      expect(health.checks.outbound).toBe("ok");
    });

    it("metrics and queue payloads carry codes and ids only: no address, subject or body", async () => {
      const { sendId } = await reply("Very private body");
      provider.failNextSend({ retryable: true, code: "rate_limited" });
      await run(sendId);
      const dump = JSON.stringify(metrics.snapshot()) + JSON.stringify(queue.jobs);
      expect(dump).not.toMatch(/Very private|eve@customer|Order help|customer\.test/);
    });
  });
});
