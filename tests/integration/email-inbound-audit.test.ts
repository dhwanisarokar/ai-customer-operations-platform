import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as inboundRoute } from "@/app/api/email/inbound/route";
import { automationInputSchema } from "@/server/automation/definition";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { INBOUND_LIMITS, ingestInboundEmail } from "@/server/email/inbound";
import {
  handleInboundWebhook,
  MAX_WEBHOOK_BODY_BYTES,
  WEBHOOK_EVENT_RETENTION_DAYS,
  purgeExpiredWebhookEvents,
} from "@/server/email/inbound-webhook";
import type { NormalizedInboundEmail } from "@/server/email/provider";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { createAutomation } from "@/server/services/automations";
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
const ADDRESS_B = `help-b@${DOMAIN}`;
const DEFAULT_LIMITS = { ...INBOUND_LIMITS };
let counter = 1000;

describeDb("inbound email audit: regression tests for confirmed gaps and invariants", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  let queue: MemoryAutomationQueue;
  const db = async () => (await import("@/db/client")).getDb();

  async function enableEmail(organizationId: string, address: string) {
    await emailSettingsRepository.create({
      organizationId,
      localPart: address.split("@")[0],
      supportAddress: address,
      fromName: "Support",
    });
    await emailSettingsRepository.setStatus(organizationId, "ACTIVE", null);
    await emailSettingsRepository.setEnabled(organizationId, true);
  }

  function mail(overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
    counter += 1;
    return sampleInbound({
      providerMessageId: `audit-${counter}`,
      messageId: `<audit${counter}@customer.test>`,
      from: `sender${counter}@customer.test`,
      fromName: "Sender",
      deliveredTo: [ADDRESS_A],
      to: [ADDRESS_A],
      subject: "Audit",
      text: "Hello",
      ...overrides,
    });
  }

  async function deliver(email: NormalizedInboundEmail, at: Date = new Date()) {
    return handleInboundWebhook(provider.receive(email, at).webhook);
  }

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("audit-secret");
    setEmailProviderForTesting(provider);
    queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    setAutomationQueueForTesting(queue);
    await enableEmail(t.orgA.id, ADDRESS_A);
    await enableEmail(t.orgB.id, ADDRESS_B);
    as(t.adminA);
  });

  afterEach(() => {
    Object.assign(INBOUND_LIMITS, DEFAULT_LIMITS);
    setEmailProviderForTesting(undefined);
    setAutomationQueueForTesting(undefined);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  // ---- 1. sender authentication ------------------------------------------------------------------------
  // The exhaustive contract tests (schema rejection, alignment table, realistic scenarios) are in
  // src/server/email/sender-auth.test.ts; these cover the end-to-end behavior through the real pipeline.

  describe("sender authentication", () => {
    it("claims inside the sender-controlled content cannot upgrade an unauthenticated message", async () => {
      const res = await deliver(
        mail({
          senderAuth: auth.none,
          subject: "Authentication-Results: mx; spf=pass; dkim=pass",
          text: "Authentication-Results: spf=pass smtp.mailfrom=customer.test\nReceived-SPF: pass\nX-Spam-Status: No",
          fromName: "dkim=pass spf=pass",
        }),
      );
      expect(res.body.status).toBe("held");
      expect(await (await db()).customer.count()).toBe(0);
    });

    it("a spoofer who authenticates THEIR OWN domain is held, with the reason recorded", async () => {
      const res = await deliver(
        mail({ from: "ceo@customer.test", senderAuth: auth.aligned("evil.test") }),
      );
      expect(res.body.status).toBe("held");
      const held = await (await db()).emailHeldMessage.findFirstOrThrow();
      expect(held).toMatchObject({ reason: "UNAUTHENTICATED_SENDER", spf: "fail", dkim: "fail" });
      expect(held.authDetail).toMatchObject({
        fromDomain: "customer.test",
        via: null,
        spf: { result: "pass", domain: "evil.test", aligned: false },
        dkim: [{ result: "pass", domain: "evil.test", aligned: false }],
      });
    });

    it("an authenticated message stores the verdicts and how they were judged", async () => {
      await deliver(
        mail({
          from: "ana@customer.test",
          senderAuth: { spf: auth.fail(), dkim: [auth.pass("customer.test")] },
        }),
      );
      const row = await (await db()).emailMessage.findFirstOrThrow();
      expect(row).toMatchObject({ spf: "fail", dkim: "pass" });
      expect(row.authDetail).toMatchObject({ via: "dkim", fromDomain: "customer.test" });
    });

    it("conflicting verdicts follow DMARC logic: one ALIGNED pass is enough, no aligned pass is not", async () => {
      expect(
        (
          await deliver(
            mail({ senderAuth: { spf: auth.fail(), dkim: [auth.pass("customer.test")] } }),
          )
        ).body.status,
      ).toBe("processed");
      expect(
        (
          await deliver(
            mail({
              senderAuth: { spf: auth.pass("customer.test"), dkim: [auth.fail("customer.test")] },
            }),
          )
        ).body.status,
      ).toBe("processed");
      expect((await deliver(mail({ senderAuth: auth.failedAll }))).body.status).toBe("held");
    });
  });

  // ---- 2. replay ledger --------------------------------------------------------------------------------

  describe("replay ledger", () => {
    it("is global but cannot suppress or leak anything across tenants: it holds no tenant data", async () => {
      await deliver(mail({ deliveredTo: [ADDRESS_A, ADDRESS_B] }));
      const rows = await (await db()).emailWebhookEvent.findMany();
      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]).sort()).toEqual(
        ["createdAt", "id", "outcome", "reason", "replayKey"].sort(),
      );
    });

    it("one organization failing mid-way does not lose the other: the retry completes it", async () => {
      const email = mail({ deliveredTo: [ADDRESS_A, ADDRESS_B] });
      const { webhook } = provider.receive(email);
      const { emailInboundRepository } = await import("@/server/repositories/email-inbound");
      const original = emailInboundRepository.createEmailMessage.bind(emailInboundRepository);
      let calls = 0;
      vi.spyOn(emailInboundRepository, "createEmailMessage").mockImplementation((async (
        ...args: Parameters<typeof original>
      ) => {
        calls += 1;
        if (calls === 2) throw new Error("second organization fails");
        return original(...args);
      }) as never);
      await expect(handleInboundWebhook(webhook)).rejects.toThrow("second organization");
      expect(await (await db()).emailWebhookEvent.count()).toBe(0);
      vi.restoreAllMocks();
      const retry = await handleInboundWebhook(webhook);
      expect(retry.status).toBe(200);
      const client = await db();
      expect(await client.message.count({ where: { organizationId: t.orgA.id } })).toBe(1);
      expect(await client.message.count({ where: { organizationId: t.orgB.id } })).toBe(1);
    });

    it("purges only entries older than the retention and never inside the safety floor", async () => {
      const client = await db();
      const day = 24 * 3600_000;
      await client.emailWebhookEvent.createMany({
        data: [
          { replayKey: "old", outcome: "PROCESSED", createdAt: new Date(Date.now() - 40 * day) },
          { replayKey: "recent", outcome: "PROCESSED", createdAt: new Date(Date.now() - 2 * day) },
        ],
      });
      expect(WEBHOOK_EVENT_RETENTION_DAYS).toBeGreaterThanOrEqual(7);
      // A retention below the floor is refused instead of silently weakening replay protection.
      await expect(purgeExpiredWebhookEvents({ olderThanDays: 0 })).rejects.toThrow();
      await expect(purgeExpiredWebhookEvents({ olderThanDays: 1 })).rejects.toThrow();
      const removed = await purgeExpiredWebhookEvents({ olderThanDays: 30 });
      expect(removed).toBe(1);
      expect((await client.emailWebhookEvent.findMany()).map((r) => r.replayKey)).toEqual([
        "recent",
      ]);
    });

    it("a purged ledger entry never causes a duplicate: the stored provider message id still dedupes", async () => {
      const email = mail();
      expect((await deliver(email)).body.status).toBe("processed");
      await (await db()).emailWebhookEvent.deleteMany();
      const again = await deliver(email);
      expect(again.body.status).toBe("duplicate");
      expect(await (await db()).message.count()).toBe(1);
    });

    it("an old signed notification is refused as stale even if its ledger entry was purged", async () => {
      const { webhook } = provider.receive(mail(), new Date(Date.now() - 60 * 24 * 3600_000));
      expect((await handleInboundWebhook(webhook)).status).toBe(401);
    });
  });

  // ---- 3. transactions and events ----------------------------------------------------------------------

  describe("transactions and events", () => {
    it("a failing realtime/automation publisher never fails or duplicates the stored message", async () => {
      const engine = await import("@/server/automation/engine");
      vi.spyOn(engine, "dispatchDomainEvent").mockRejectedValue(new Error("engine down"));
      const realtime = await import("@/server/realtime/publisher");
      vi.spyOn(realtime, "publishRealtime").mockRejectedValue(new Error("redis down"));
      const email = mail();
      const res = await deliver(email);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processed");
      const client = await db();
      expect(await client.message.count()).toBe(1);
      expect(await client.emailWebhookEvent.count()).toBe(1);
      vi.restoreAllMocks();
      expect((await deliver(email)).body.status).toBe("duplicate");
      expect(await client.message.count()).toBe(1);
    });

    it("an exception while announcing AFTER the commit does not turn a stored message into a retry", async () => {
      const bus = await import("@/server/events/bus");
      vi.spyOn(bus, "emitDomainEvent").mockRejectedValue(new Error("announce failed"));
      const email = mail();
      const { webhook } = provider.receive(email);
      const res = await handleInboundWebhook(webhook);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processed");
      expect(await (await db()).message.count()).toBe(1);
      expect(await (await db()).emailWebhookEvent.count()).toBe(1);
    });

    it("provider retries and concurrent deliveries cause exactly one automation effect", async () => {
      const automation = await createAutomation(
        await requireOrganizationContext(),
        automationInputSchema.parse({
          name: "on customer message",
          trigger: "message.created",
          conditions: [{ field: "senderType", operator: "equals", value: "CUSTOMER" }],
          actions: [{ type: "create_customer_note", input: { content: "fired" } }],
        }),
      );
      const email = mail();
      const first = provider.receive(email);
      const second = provider.receive(email); // a different notification of the same message
      await Promise.all([
        handleInboundWebhook(first.webhook),
        handleInboundWebhook(first.webhook),
        handleInboundWebhook(second.webhook),
        handleInboundWebhook(second.webhook),
      ]);
      await queue.drain();
      const client = await db();
      expect(await client.message.count()).toBe(1);
      expect(await client.conversation.count()).toBe(1);
      expect(await client.customer.count()).toBe(1);
      expect(
        await client.automationExecution.count({ where: { automationId: automation.id } }),
      ).toBe(1);
      expect(await client.customerNote.count()).toBe(1);
    });

    it("concurrent replies on a RESOLVED conversation reopen it once (one event, one status change)", async () => {
      await deliver(mail({ messageId: "<thread-root@customer.test>", from: "eve@customer.test" }));
      const client = await db();
      const conversation = await client.conversation.findFirstOrThrow();
      await client.conversation.update({
        where: { id: conversation.id },
        data: { status: "RESOLVED", closedAt: new Date() },
      });
      const events: string[] = [];
      const { subscribeRealtime } = await import("@/server/realtime/publisher");
      const { inboxChannel } = await import("@/server/realtime/channels");
      const off = subscribeRealtime(inboxChannel(t.orgA.id), (e) => events.push(e.type));
      await Promise.all(
        [1, 2, 3].map(() =>
          deliver(mail({ from: "eve@customer.test", inReplyTo: "<thread-root@customer.test>" })),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      off();
      expect(
        await client.conversationEvent.count({
          where: { conversationId: conversation.id, type: "STATUS_CHANGED" },
        }),
      ).toBe(1);
      expect(events.filter((e) => e === "conversation.status_changed")).toHaveLength(1);
      expect(await client.message.count({ where: { conversationId: conversation.id } })).toBe(4);
    });
  });

  // ---- 4. abuse controls -------------------------------------------------------------------------------

  describe("abuse controls are exact under concurrency", () => {
    it("the per-sender limit holds exactly when many emails arrive at once", async () => {
      INBOUND_LIMITS.perSender = 3;
      const results = await Promise.all(
        Array.from({ length: 12 }, () => deliver(mail({ from: "flood@customer.test" }))),
      );
      const client = await db();
      expect(await client.message.count()).toBe(3);
      expect(results.filter((r) => r.body.status === "processed")).toHaveLength(3);
      expect(results.filter((r) => r.body.status === "ignored")).toHaveLength(9);
      expect(results.every((r) => r.status === 200)).toBe(true);
    });

    it("the organization limit holds exactly under concurrency and does not touch another organization", async () => {
      INBOUND_LIMITS.perOrganization = 4;
      const toA = Array.from({ length: 10 }, () => deliver(mail()));
      const toB = Array.from({ length: 3 }, () =>
        deliver(mail({ deliveredTo: [ADDRESS_B], to: [ADDRESS_B] })),
      );
      await Promise.all([...toA, ...toB]);
      const client = await db();
      expect(await client.message.count({ where: { organizationId: t.orgA.id } })).toBe(4);
      expect(await client.message.count({ where: { organizationId: t.orgB.id } })).toBe(3);
    });

    it("the held-queue cap holds exactly under concurrency", async () => {
      INBOUND_LIMITS.openHeldPerOrganization = 3;
      await Promise.all(Array.from({ length: 10 }, () => deliver(mail({ senderAuth: auth.none }))));
      expect(await (await db()).emailHeldMessage.count()).toBe(3);
    });

    it("a capped-out organization drops with 200 and a coded ledger entry, as documented", async () => {
      INBOUND_LIMITS.perOrganization = 1;
      await deliver(mail());
      const res = await deliver(mail());
      expect(res).toMatchObject({ status: 200, body: { status: "ignored" } });
      const reasons = (await (await db()).emailWebhookEvent.findMany()).map((r) => r.reason);
      expect(reasons).toContain("rate_limited_organization");
    });

    it("an organization capped out by one flood still accepts nothing else, but another organization is unaffected", async () => {
      INBOUND_LIMITS.perOrganization = 2;
      await Promise.all(Array.from({ length: 5 }, () => deliver(mail())));
      const other = await deliver(mail({ deliveredTo: [ADDRESS_B], to: [ADDRESS_B] }));
      expect(other.body.status).toBe("processed");
    });
  });

  // ---- 6. webhook order, body size, normalization ------------------------------------------------------

  describe("webhook request handling", () => {
    const post = (init: RequestInit & { duplex?: "half" }) =>
      (
        inboundRoute as unknown as (
          r: Request,
          c: { params: Promise<unknown> },
        ) => Promise<Response>
      )(new Request("http://localhost/api/email/inbound", { method: "POST", ...init }), {
        params: Promise.resolve({}),
      });

    it("refuses an oversized CHUNKED body (no content-length) without buffering all of it", async () => {
      let pulled = 0;
      const chunk = new Uint8Array(16 * 1024).fill(120);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += chunk.length;
          if (pulled > 8 * 1024 * 1024) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const res = await post({ body: stream, duplex: "half" });
      expect(res.status).toBe(413);
      expect(pulled).toBeLessThan(MAX_WEBHOOK_BODY_BYTES + 1024 * 1024);
    });

    it("refuses a lying or malformed content-length", async () => {
      const lie = await post({
        body: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 5),
        headers: { "content-length": "10" },
      });
      expect([400, 413]).toContain(lie.status);
    });

    it("rejects an unsigned request before any state is read (no ledger, no fetch, no org lookup)", async () => {
      const fetches = vi.spyOn(provider, "fetchInboundEmail");
      const res = await post({ body: JSON.stringify({ type: "inbound", id: "x", ref: "y" }) });
      expect(res.status).toBe(400);
      expect(fetches).not.toHaveBeenCalled();
      expect(await (await db()).emailWebhookEvent.count()).toBe(0);
    });

    it("answers 404 when the platform domain is not configured (no loop protection without it)", async () => {
      const { webhook } = provider.receive(mail());
      vi.stubEnv("EMAIL_PLATFORM_DOMAIN", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      expect((await handleInboundWebhook(webhook)).status).toBe(404);
      expect(await (await db()).message.count()).toBe(0);
    });
  });

  describe("plain-text normalization", () => {
    it("stored display names, To and Cc are single-line, valid, lower-case addresses", async () => {
      await deliver(
        mail({
          fromName: "Eve\r\nBcc: x@evil.test",
          to: [ADDRESS_A, "Bad <a@b.test>", "UPPER@Customer.TEST", "x\r\ny@z.test"],
          cc: ["boss@customer.test", "not an address", "a@b.test\u0000"],
        }),
      );
      const row = await (await db()).emailMessage.findFirstOrThrow();
      expect(row.fromName).not.toMatch(/[\r\n]/);
      expect(row.toAddresses).toEqual([ADDRESS_A, "upper@customer.test"]);
      expect(row.ccAddresses).toEqual(["boss@customer.test"]);
    });

    it("held mail is sanitized the same way", async () => {
      await deliver(mail({ fromName: "Eve\r\nBcc: x", senderAuth: auth.none }));
      const held = await (await db()).emailHeldMessage.findFirstOrThrow();
      expect(held.fromName).not.toMatch(/[\r\n]/);
    });

    it("bidirectional override characters cannot disguise names, subjects, filenames or text", async () => {
      await deliver(
        mail({
          fromName: "Eve \u202eexe.pdf",
          subject: "Invoice \u202etxt.exe",
          text: "pay \u202eto evil\u2066 now\u2069",
          attachments: [
            { filename: "invoice\u202efdp.exe", contentType: "application/pdf", size: 1 },
          ],
        }),
      );
      const client = await db();
      const customer = await client.customer.findFirstOrThrow();
      const conversation = await client.conversation.findFirstOrThrow();
      const message = await client.message.findFirstOrThrow();
      const email = await client.emailMessage.findFirstOrThrow();
      const bidi = /[\u202a-\u202e\u2066-\u2069]/;
      expect(customer.firstName).not.toMatch(bidi);
      expect(conversation.subject).not.toMatch(bidi);
      expect(message.body).not.toMatch(bidi);
      expect(JSON.stringify(email.attachments)).not.toMatch(bidi);
      expect(email.fromName ?? "").not.toMatch(bidi);
    });

    it("legitimate right-to-left text (marks, Arabic, Hebrew) is preserved", async () => {
      await deliver(mail({ text: "مرحبا ‏ שלום ‎ hello" }));
      const message = await (await db()).message.findFirstOrThrow();
      expect(message.body).toBe("مرحبا ‏ שלום ‎ hello");
    });
  });

  describe("hardening constraints and the shared message path", () => {
    async function rowBase() {
      await deliver(mail());
      const client = await db();
      const stored = await client.emailMessage.findFirstOrThrow();
      const message = await (
        await import("../helpers/conversations")
      ).seedMessage(t.orgA.id, stored.conversationId);
      return {
        client,
        data: {
          organizationId: t.orgA.id,
          conversationId: stored.conversationId,
          messageId: message.id,
          direction: "INBOUND" as const,
          providerMessageId: "constraint-probe",
          fromAddress: "x@y.test",
          subject: "s",
          spf: "pass",
          dkim: "pass",
          receivedAt: new Date(),
        },
      };
    }

    it.each([
      ["a bidi override in the display name", { fromName: "Eve \u202eexe" }],
      ["a line break in the display name", { fromName: "Eve\nBcc: x" }],
      ["a line separator in the subject", { subject: "a\u2028b" }],
      ["a control character in the subject", { subject: "a\u0007b" }],
      ["whitespace in the sender address", { fromAddress: "a b@y.test" }],
      ["an angle bracket in the sender address", { fromAddress: "<a@y.test>" }],
      ["a comma in the sender address", { fromAddress: "a@y.test,b@y.test" }],
      ["a control character in the provider id", { providerMessageId: "id\u0001x" }],
    ])("email_messages refuses %s", async (_label, patch) => {
      const { client, data } = await rowBase();
      await expect(client.emailMessage.create({ data: { ...data, ...patch } })).rejects.toThrow();
    });

    it("email_messages still accepts right-to-left text and direction marks", async () => {
      const { client, data } = await rowBase();
      await expect(
        client.emailMessage.create({
          data: { ...data, fromName: "שלום ‏ مرحبا", subject: "تحية ‎ hello" },
        }),
      ).resolves.toBeTruthy();
    });

    it("email_held_messages refuses the same", async () => {
      const { client } = await rowBase();
      const held = {
        organizationId: t.orgA.id,
        reason: "ARCHIVED_CUSTOMER" as const,
        providerMessageId: "held-probe",
        fromAddress: "x@y.test",
        subject: "s",
        body: "b",
        spf: "pass",
        dkim: "pass",
        receivedAt: new Date(),
      };
      for (const patch of [
        { fromName: "a\u202eb" },
        { subject: "a\nb" },
        { fromAddress: "a b@y.test" },
        { providerMessageId: "x\u0002" },
      ]) {
        await expect(
          client.emailHeldMessage.create({ data: { ...held, ...patch } }),
        ).rejects.toThrow();
      }
    });

    it("a poison message (NUL bytes everywhere) is neutralized, not retried forever", async () => {
      const res = await deliver(
        mail({
          fromName: "Eve\u0000",
          subject: "Hi\u0000",
          text: "text\u0000",
          to: ["a@b.test\u0000", ADDRESS_A],
          cc: ["c@d.test\u0000"],
          attachments: [{ filename: "a\u0000.pdf", contentType: "x\u0000", size: 1 }],
        }),
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processed");
    });

    it("a provider message id with control characters is rejected as malformed", async () => {
      const results = await ingestInboundEmail(mail({ providerMessageId: "id\u0000x" }));
      expect(results).toEqual([{ status: "ignored", reason: "malformed_message" }]);
    });

    it("a message reads the conversation state only after taking the row lock (no stale reopen)", async () => {
      const { persistMessage } = await import("@/server/services/conversation-messages");
      const { conversationsRepository } = await import("@/server/repositories/conversations");
      const { transaction } = await import("@/db/client");
      const { seedCustomer } = await import("../helpers/tenants");
      const { seedConversation } = await import("../helpers/conversations");
      const customer = await seedCustomer(t.orgA.id, { firstName: "Lock", email: "l@c.test" });
      const conversation = await seedConversation(t.orgA.id, customer.id, { status: "RESOLVED" });
      let pending: Promise<unknown> = Promise.resolve();
      await transaction(async (tx) => {
        await conversationsRepository.lock(t.orgA.id, conversation.id, tx);
        pending = persistMessage({
          organizationId: t.orgA.id,
          actor: { kind: "portal", customerId: customer.id },
          conversationId: conversation.id,
          input: { body: "second", type: "MESSAGE", from: "CUSTOMER" },
        });
        // Meanwhile the lock holder reopens the conversation (it is "another customer message" winning).
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tx.conversation.update({
          where: { id: conversation.id },
          data: { status: "OPEN", closedAt: null },
        });
      });
      await pending;
      // The waiting message saw OPEN (it read after the lock), so it must not record a second reopen.
      const client = await db();
      expect(
        await client.conversationEvent.count({
          where: { conversationId: conversation.id, type: "STATUS_CHANGED" },
        }),
      ).toBe(0);
    });

    it("concurrent customer messages on a RESOLVED conversation reopen it once on ANY channel", async () => {
      const { persistMessage } = await import("@/server/services/conversation-messages");
      const { seedCustomer } = await import("../helpers/tenants");
      const { seedConversation } = await import("../helpers/conversations");
      const customer = await seedCustomer(t.orgA.id, { firstName: "Portal", email: "p@c.test" });
      const conversation = await seedConversation(t.orgA.id, customer.id, { status: "RESOLVED" });
      await Promise.all(
        [1, 2, 3, 4].map((n) =>
          persistMessage({
            organizationId: t.orgA.id,
            actor: { kind: "portal", customerId: customer.id },
            conversationId: conversation.id,
            input: { body: `m${n}`, type: "MESSAGE", from: "CUSTOMER" },
          }),
        ),
      );
      const client = await db();
      expect(
        await client.conversationEvent.count({
          where: { conversationId: conversation.id, type: "STATUS_CHANGED" },
        }),
      ).toBe(1);
      expect(await client.message.count({ where: { conversationId: conversation.id } })).toBe(4);
    });
  });

  // ---- 5. held messages: storage boundary ---------------------------------------------------------------

  describe("held messages are not reachable through any API or service yet", () => {
    it("only the repository touches the held table (no route, service or UI reads it)", async () => {
      const { readdirSync, readFileSync, statSync } = await import("node:fs");
      const { join } = await import("node:path");
      const walk = (dir: string): string[] =>
        readdirSync(dir).flatMap((name) => {
          const path = join(dir, name);
          if (path.includes("generated")) return [];
          return statSync(path).isDirectory() ? walk(path) : [path];
        });
      const users = walk(join(process.cwd(), "src")).filter(
        (file) =>
          /\.(ts|tsx)$/.test(file) &&
          !/\.test\./.test(file) &&
          /emailHeldMessage|email_held_messages|countOpenHeld|createHeld/.test(
            readFileSync(file, "utf8"),
          ),
      );
      expect(users.map((f) => f.replace(/\\/g, "/").split("/src/")[1]).sort()).toEqual(
        ["server/email/inbound.ts", "server/repositories/email-inbound.ts"].sort(),
      );
    });
  });
});
