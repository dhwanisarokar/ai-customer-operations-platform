import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as inboundRoute } from "@/app/api/email/inbound/route";
import { automationInputSchema } from "@/server/automation/definition";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { requireOrganizationContext } from "@/server/auth/context";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider } from "@/server/email/fake-provider";
import { INBOUND_LIMITS, ingestInboundEmail } from "@/server/email/inbound";
import { handleInboundWebhook, MAX_WEBHOOK_BODY_BYTES } from "@/server/email/inbound-webhook";
import type { NormalizedInboundEmail } from "@/server/email/provider";
import type { RealtimeEvent } from "@/server/realtime/events";
import { inboxChannel } from "@/server/realtime/channels";
import { subscribeRealtime } from "@/server/realtime/publisher";
import { emailInboundRepository } from "@/server/repositories/email-inbound";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { createAutomation } from "@/server/services/automations";
import { sendMessage } from "@/server/services/conversation-messages";
import { auth } from "../helpers/email-auth";
import { sampleInbound } from "../helpers/email-provider-contract";
import { seedConversation, seedMessage } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const ADDRESS_A = `help-a@${DOMAIN}`;
const ADDRESS_B = `help-b@${DOMAIN}`;
const DEFAULT_LIMITS = { ...INBOUND_LIMITS };
const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
let counter = 0;

describeDb("inbound email: routing, matching, threading, safety", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  let queue: MemoryAutomationQueue;
  const db = async () => (await import("@/db/client")).getDb();

  /** An enabled, verified support address for an organization (what 9.1's settings produce). */
  async function enableEmail(organizationId: string, address: string) {
    const local = address.split("@")[0];
    await emailSettingsRepository.create({
      organizationId,
      localPart: local,
      supportAddress: address,
      fromName: "Support",
    });
    await emailSettingsRepository.setStatus(organizationId, "ACTIVE", null);
    await emailSettingsRepository.setEnabled(organizationId, true);
  }

  /** An email as the adapter would hand it over, addressed to org A unless said otherwise. */
  function mail(overrides: Partial<NormalizedInboundEmail> = {}): NormalizedInboundEmail {
    counter += 1;
    return sampleInbound({
      providerMessageId: `pm-${counter}`,
      messageId: `<m${counter}@customer.test>`,
      from: "eve@customer.test",
      fromName: "Eve Example",
      deliveredTo: [ADDRESS_A],
      to: [ADDRESS_A],
      subject: "Help with my order",
      text: "My order has not arrived.",
      ...overrides,
    });
  }

  /** The full path a provider notification takes: signed webhook -> fetch -> ingest. */
  async function deliver(email: NormalizedInboundEmail, at: Date = new Date()) {
    const { webhook } = provider.receive(email, at);
    return handleInboundWebhook(webhook);
  }

  const counts = async () => {
    const client = await db();
    return {
      customers: await client.customer.count(),
      conversations: await client.conversation.count(),
      messages: await client.message.count(),
      emails: await client.emailMessage.count(),
      held: await client.emailHeldMessage.count(),
    };
  };

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("inbound-secret");
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

  describe("a first email from an unknown sender", () => {
    it("creates the customer, an EMAIL conversation handled by people, the message and its email record", async () => {
      const res = await deliver(
        mail({ subject: "Re: Fwd: Help with my order", text: "Where is my parcel?" }),
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("processed");

      const client = await db();
      const customer = await client.customer.findFirstOrThrow({
        where: { organizationId: t.orgA.id, email: "eve@customer.test" },
      });
      expect(customer).toMatchObject({
        firstName: "Eve Example",
        source: "email",
        status: "ACTIVE",
      });

      const conversation = await client.conversation.findFirstOrThrow({
        where: { organizationId: t.orgA.id },
      });
      expect(conversation).toMatchObject({
        customerId: customer.id,
        channel: "EMAIL",
        handlingMode: "HUMAN",
        status: "OPEN",
        subject: "Help with my order",
        lastMessageSenderType: "CUSTOMER",
        lastMessagePreview: "Where is my parcel?",
      });
      expect(conversation.lastCustomerMessageAt).not.toBeNull();

      const message = await client.message.findFirstOrThrow({
        where: { conversationId: conversation.id },
      });
      expect(message).toMatchObject({
        senderType: "CUSTOMER",
        senderUserId: null,
        messageType: "MESSAGE",
        body: "Where is my parcel?",
      });

      const email = await client.emailMessage.findFirstOrThrow({
        where: { conversationId: conversation.id },
      });
      expect(email).toMatchObject({
        organizationId: t.orgA.id,
        messageId: message.id,
        direction: "INBOUND",
        fromAddress: "eve@customer.test",
        spf: "pass",
        dkim: "pass",
      });

      const events = await client.conversationEvent.findMany({
        where: { conversationId: conversation.id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
      expect(events.map((e) => e.type)).toEqual(["CONVERSATION_CREATED", "MESSAGE_SENT"]);
      expect(events.every((e) => e.actorType === "CUSTOMER" && e.actorId === customer.id)).toBe(
        true,
      );

      const activity = await client.customerActivity.findFirstOrThrow({
        where: { customerId: customer.id, type: "CUSTOMER_CREATED" },
      });
      expect(activity.actorType).toBe("SYSTEM");
    });

    it("falls back to the address' local part when there is no display name", async () => {
      await deliver(mail({ fromName: null, from: "jane.doe@customer.test" }));
      const customer = await (
        await db()
      ).customer.findFirstOrThrow({
        where: { email: "jane.doe@customer.test" },
      });
      expect(customer.firstName).toBe("jane.doe");
    });

    it("sanitizes a hostile display name, subject and body (plain text only)", async () => {
      await deliver(
        mail({
          fromName: 'Eve\r\nBcc: x@evil.test <script>"',
          subject: "Hi\r\nBcc: victim@x.test",
          text: "line1\r\nline2\u0000\u0007<img src=x onerror=alert(1)>\n\n\n\n\n\nend",
        }),
      );
      const client = await db();
      const customer = await client.customer.findFirstOrThrow({
        where: { organizationId: t.orgA.id },
      });
      expect(customer.firstName).not.toMatch(/[\r\n"<>]/);
      const conversation = await client.conversation.findFirstOrThrow({});
      expect(conversation.subject).not.toMatch(/[\r\n]/);
      const message = await client.message.findFirstOrThrow({});
      expect(message.body).not.toMatch(/[\u0000\u0007\r]/);
      expect(message.body).not.toMatch(/\n{4,}/);
      // Stored as text: markup is not interpreted or stripped into something else.
      expect(message.body).toContain("<img src=x onerror=alert(1)>");
    });

    it("bounds the body like a staff message and never stores 100k characters", async () => {
      await deliver(mail({ text: "x".repeat(100_000) }));
      const message = await (await db()).message.findFirstOrThrow({});
      expect(message.body.length).toBeLessThanOrEqual(10_000);
      expect(message.body).toMatch(/\[Message truncated\]$/);
    });

    it("stores a placeholder for an empty body and records attachments as metadata only", async () => {
      await deliver(
        mail({
          text: "   ",
          attachments: [
            { filename: "inv\r\noice.pdf", contentType: "application/pdf", size: 1234 },
          ],
        }),
      );
      const client = await db();
      expect((await client.message.findFirstOrThrow({})).body).toBe("(no text content)");
      const email = await client.emailMessage.findFirstOrThrow({});
      expect(email.attachments).toEqual([
        { filename: "inv oice.pdf", contentType: "application/pdf", size: 1234 },
      ]);
    });

    it("records To and CC as metadata without routing or replying to them", async () => {
      await deliver(mail({ cc: ["boss@customer.test", ADDRESS_B] }));
      const client = await db();
      const email = await client.emailMessage.findFirstOrThrow({});
      expect(email.ccAddresses).toEqual(["boss@customer.test", ADDRESS_B]);
      // org B is only a CC: it received nothing.
      expect(await client.conversation.count({ where: { organizationId: t.orgB.id } })).toBe(0);
    });
  });

  describe("customer matching", () => {
    it("attaches to the existing customer, case-insensitively, without creating a duplicate", async () => {
      const eve = await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@customer.test" });
      await deliver(mail({ from: "Eve@Customer.TEST" }));
      const client = await db();
      expect(await client.customer.count({ where: { organizationId: t.orgA.id } })).toBe(1);
      const conversation = await client.conversation.findFirstOrThrow({});
      expect(conversation.customerId).toBe(eve.id);
    });

    it("the same address in another organization is a different customer", async () => {
      await seedCustomer(t.orgB.id, { firstName: "Other Eve", email: "eve@customer.test" });
      await deliver(mail());
      const client = await db();
      expect(await client.customer.count({ where: { email: "eve@customer.test" } })).toBe(2);
      expect(await client.conversation.count({ where: { organizationId: t.orgB.id } })).toBe(0);
    });

    it("holds mail from an ARCHIVED customer instead of reviving or attaching it", async () => {
      const old = await seedCustomer(t.orgA.id, {
        firstName: "Old",
        email: "eve@customer.test",
        status: "ARCHIVED",
      });
      const res = await deliver(mail({ text: "Please help again" }));
      expect(res.body.status).toBe("held");
      const client = await db();
      expect(await counts()).toMatchObject({ conversations: 0, messages: 0, emails: 0, held: 1 });
      expect((await client.customer.findUniqueOrThrow({ where: { id: old.id } })).status).toBe(
        "ARCHIVED",
      );
      const held = await client.emailHeldMessage.findFirstOrThrow({});
      expect(held).toMatchObject({
        organizationId: t.orgA.id,
        reason: "ARCHIVED_CUSTOMER",
        fromAddress: "eve@customer.test",
        body: "Please help again",
        resolvedAt: null,
      });
    });

    it("never attaches an unauthenticated (possibly spoofed) sender to an existing customer", async () => {
      const eve = await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@customer.test" });
      const conversation = await seedConversation(t.orgA.id, eve.id);
      for (const senderAuth of [auth.none, auth.failedAll, auth.spfFailOnly] as const) {
        const res = await deliver(mail({ senderAuth }));
        expect(res.body.status).toBe("held");
      }
      const client = await db();
      expect(await client.message.count({ where: { conversationId: conversation.id } })).toBe(0);
      expect(await client.conversation.count()).toBe(1);
      expect(
        await client.emailHeldMessage.count({ where: { reason: "UNAUTHENTICATED_SENDER" } }),
      ).toBe(3);
    });

    it("does not create a customer for an unauthenticated sender", async () => {
      await deliver(mail({ senderAuth: auth.none }));
      expect(await counts()).toMatchObject({ customers: 0, conversations: 0, held: 1 });
    });

    it.each([
      [auth.spfOnly("customer.test")],
      [auth.dkimOnly("customer.test")],
      [{ spf: auth.fail(), dkim: [auth.pass("customer.test")] }],
    ])("accepts a sender authenticated by SPF or DKIM (%j)", async (senderAuth) => {
      const res = await deliver(mail({ senderAuth }));
      expect(res.body.status).toBe("processed");
    });
  });

  describe("threading by RFC headers", () => {
    async function firstEmail() {
      await deliver(mail({ messageId: "<root@customer.test>" }));
      const client = await db();
      return client.conversation.findFirstOrThrow({ where: { organizationId: t.orgA.id } });
    }

    it("In-Reply-To appends to the same conversation", async () => {
      const conversation = await firstEmail();
      const res = await deliver(mail({ inReplyTo: "<root@customer.test>", text: "Any news?" }));
      expect(res.body.status).toBe("processed");
      const client = await db();
      expect(await client.conversation.count()).toBe(1);
      const messages = await client.message.findMany({
        where: { conversationId: conversation.id },
        orderBy: { createdAt: "asc" },
      });
      expect(messages.map((m) => m.body)).toEqual(["My order has not arrived.", "Any news?"]);
      expect(await client.emailMessage.count({ where: { conversationId: conversation.id } })).toBe(
        2,
      );
      expect(await client.customer.count()).toBe(1);
    });

    it("uses References when In-Reply-To is unknown", async () => {
      const conversation = await firstEmail();
      await deliver(
        mail({ inReplyTo: "<unknown@elsewhere.test>", references: ["<root@customer.test>"] }),
      );
      const client = await db();
      expect(await client.conversation.count()).toBe(1);
      expect(await client.message.count({ where: { conversationId: conversation.id } })).toBe(2);
    });

    it("never threads by subject alone", async () => {
      await firstEmail();
      await deliver(mail({ subject: "Re: Help with my order" }));
      expect(await (await db()).conversation.count()).toBe(2);
    });

    it("ignores malformed header ids", async () => {
      await firstEmail();
      await deliver(mail({ inReplyTo: "root@customer.test", references: ["not an id", "<a b>"] }));
      expect(await (await db()).conversation.count()).toBe(2);
    });

    it.each(["RESOLVED", "PENDING"] as const)(
      "a reply on a %s conversation reopens it with the usual event",
      async (status) => {
        const conversation = await firstEmail();
        const client = await db();
        await client.conversation.update({
          where: { id: conversation.id },
          data: { status, closedAt: status === "RESOLVED" ? new Date() : null },
        });
        const events: RealtimeEvent[] = [];
        const off = subscribeRealtime(inboxChannel(t.orgA.id), (e) => events.push(e));
        await deliver(mail({ inReplyTo: "<root@customer.test>" }));
        await tick();
        off();
        const reopened = await client.conversation.findUniqueOrThrow({
          where: { id: conversation.id },
        });
        expect(reopened).toMatchObject({ status: "OPEN", closedAt: null });
        const changes = await client.conversationEvent.findMany({
          where: { conversationId: conversation.id, type: "STATUS_CHANGED" },
        });
        expect(changes).toHaveLength(1);
        expect(changes[0].metadata).toMatchObject({
          from: status,
          to: "OPEN",
          reason: "customer_message",
        });
        expect(events.some((e) => e.type === "conversation.status_changed")).toBe(true);
      },
    );

    it("a reply never changes an explicit handling mode and an assigned owner stays", async () => {
      const conversation = await firstEmail();
      const client = await db();
      await client.conversation.update({
        where: { id: conversation.id },
        data: { assignedToUserId: t.adminA.id },
      });
      await deliver(mail({ inReplyTo: "<root@customer.test>" }));
      const after = await client.conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after).toMatchObject({ handlingMode: "HUMAN", assignedToUserId: t.adminA.id });
    });

    it("a header from ANOTHER organization's thread is unknown here: new conversation, other tenant untouched", async () => {
      // Org B has a thread with this Message-ID.
      await deliver(
        mail({
          messageId: "<shared@customer.test>",
          deliveredTo: [ADDRESS_B],
          to: [ADDRESS_B],
          from: "bob@customer.test",
        }),
      );
      const client = await db();
      const bThread = await client.conversation.findFirstOrThrow({
        where: { organizationId: t.orgB.id },
      });
      const before = await client.message.count({ where: { conversationId: bThread.id } });

      const res = await deliver(
        mail({ inReplyTo: "<shared@customer.test>", from: "eve@customer.test" }),
      );
      expect(res.body.status).toBe("processed");
      expect(await client.message.count({ where: { conversationId: bThread.id } })).toBe(before);
      expect(await client.conversation.count({ where: { organizationId: t.orgA.id } })).toBe(1);
    });

    it("the same Message-ID in two organizations does not make a thread ambiguous", async () => {
      await deliver(mail({ messageId: "<same@customer.test>" }));
      await deliver(
        mail({
          messageId: "<same@customer.test>",
          deliveredTo: [ADDRESS_B],
          to: [ADDRESS_B],
          from: "bob@customer.test",
        }),
      );
      const res = await deliver(mail({ inReplyTo: "<same@customer.test>" }));
      expect(res.body.status).toBe("processed");
      expect(await (await db()).conversation.count({ where: { organizationId: t.orgA.id } })).toBe(
        1,
      );
    });

    it("holds an ambiguous thread (headers point at two conversations) instead of guessing", async () => {
      const client = await db();
      const eve = await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@customer.test" });
      const c1 = await seedConversation(t.orgA.id, eve.id);
      const c2 = await seedConversation(t.orgA.id, eve.id);
      for (const [conversation, providerMessageId] of [
        [c1, "p-a"],
        [c2, "p-b"],
      ] as const) {
        const message = await seedMessage(t.orgA.id, conversation.id);
        await emailInboundRepository.createEmailMessage({
          organizationId: t.orgA.id,
          conversationId: conversation.id,
          messageId: message.id,
          direction: "INBOUND",
          providerMessageId,
          rfcMessageId: "<dup@customer.test>",
          inReplyTo: null,
          references: [],
          fromAddress: "eve@customer.test",
          fromName: null,
          toAddresses: [],
          ccAddresses: [],
          subject: "x",
          spf: "pass",
          dkim: "pass",
          attachments: [],
          receivedAt: new Date(),
        });
      }
      const res = await deliver(mail({ inReplyTo: "<dup@customer.test>" }));
      expect(res.body.status).toBe("held");
      expect(await client.emailHeldMessage.count({ where: { reason: "AMBIGUOUS_THREAD" } })).toBe(
        1,
      );
      expect(await client.message.count()).toBe(2);
    });

    it("holds mail that quotes someone else's thread (sender is not the thread's customer)", async () => {
      await deliver(mail({ messageId: "<private@customer.test>" }));
      const client = await db();
      const thread = await client.conversation.findFirstOrThrow({
        where: { organizationId: t.orgA.id },
      });
      const res = await deliver(
        mail({
          inReplyTo: "<private@customer.test>",
          from: "mallory@elsewhere.test",
          text: "inject",
        }),
      );
      expect(res.body.status).toBe("held");
      expect(await client.message.count({ where: { conversationId: thread.id } })).toBe(1);
      expect(
        await client.emailHeldMessage.count({ where: { reason: "THREAD_SENDER_MISMATCH" } }),
      ).toBe(1);
      // The unknown sender did not become a customer either.
      expect(await client.customer.count({ where: { email: "mallory@elsewhere.test" } })).toBe(0);
    });

    it("holds a reply to a thread when the sender is unauthenticated, even with the right headers", async () => {
      await deliver(mail({ messageId: "<root2@customer.test>" }));
      const res = await deliver(
        mail({ inReplyTo: "<root2@customer.test>", senderAuth: auth.none }),
      );
      expect(res.body.status).toBe("held");
      expect(await (await db()).message.count()).toBe(1);
    });
  });

  describe("organization resolution from trusted recipient configuration", () => {
    it("routes by the envelope recipient, never by the To/Cc headers", async () => {
      // Headers say org B, the provider delivered it for org A.
      await deliver(mail({ deliveredTo: [ADDRESS_A], to: [ADDRESS_B], cc: [ADDRESS_B] }));
      const client = await db();
      expect(await client.conversation.count({ where: { organizationId: t.orgA.id } })).toBe(1);
      expect(await client.conversation.count({ where: { organizationId: t.orgB.id } })).toBe(0);
    });

    it("ignores mail whose envelope recipient is unknown, even if a header names a real address", async () => {
      const res = await deliver(mail({ deliveredTo: [`nobody@${DOMAIN}`], to: [ADDRESS_A] }));
      expect(res.body.status).toBe("ignored");
      expect(await counts()).toMatchObject({
        customers: 0,
        conversations: 0,
        messages: 0,
        held: 0,
      });
    });

    it("matches the recipient case-insensitively", async () => {
      const res = await deliver(mail({ deliveredTo: [ADDRESS_A.toUpperCase()] }));
      expect(res.body.status).toBe("processed");
    });

    it("ignores an address that is disabled, unverified or failed", async () => {
      await emailSettingsRepository.setEnabled(t.orgA.id, false);
      expect((await deliver(mail())).body.status).toBe("ignored");
      await emailSettingsRepository.setStatus(t.orgA.id, "PENDING_VERIFICATION", null);
      expect((await deliver(mail())).body.status).toBe("ignored");
      await emailSettingsRepository.setStatus(t.orgA.id, "FAILED", "provider_error");
      expect((await deliver(mail())).body.status).toBe("ignored");
      expect(await counts()).toMatchObject({ customers: 0, conversations: 0 });
    });

    it("an email delivered to two organizations becomes one conversation in EACH, isolated", async () => {
      const res = await deliver(
        mail({ deliveredTo: [ADDRESS_A, ADDRESS_B], to: [ADDRESS_A, ADDRESS_B] }),
      );
      expect(res.body.results).toEqual(["processed", "processed"]);
      const client = await db();
      expect(await client.conversation.count({ where: { organizationId: t.orgA.id } })).toBe(1);
      expect(await client.conversation.count({ where: { organizationId: t.orgB.id } })).toBe(1);
      const customers = await client.customer.findMany({ where: { email: "eve@customer.test" } });
      expect(new Set(customers.map((c) => c.organizationId))).toEqual(
        new Set([t.orgA.id, t.orgB.id]),
      );
    });
  });

  describe("deduplication and replay", () => {
    it("the same provider message delivered by two different notifications is stored once", async () => {
      const email = mail();
      expect((await deliver(email)).body.status).toBe("processed");
      const second = await deliver(email);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe("duplicate");
      expect(await counts()).toMatchObject({
        messages: 1,
        emails: 1,
        conversations: 1,
        customers: 1,
      });
    });

    it("a replayed notification is acknowledged without fetching or storing anything again", async () => {
      const { webhook } = provider.receive(mail());
      expect((await handleInboundWebhook(webhook)).body.status).toBe("processed");
      const fetches = vi.spyOn(provider, "fetchInboundEmail");
      const replay = await handleInboundWebhook(webhook);
      expect(replay).toMatchObject({ status: 200, body: { status: "duplicate" } });
      expect(fetches).not.toHaveBeenCalled();
      expect((await counts()).messages).toBe(1);
    });

    it("concurrent deliveries of the same notification store exactly one message", async () => {
      const { webhook } = provider.receive(mail());
      const results = await Promise.all([
        handleInboundWebhook(webhook),
        handleInboundWebhook(webhook),
        handleInboundWebhook(webhook),
      ]);
      expect(results.every((r) => r.status === 200)).toBe(true);
      expect(await counts()).toMatchObject({
        messages: 1,
        emails: 1,
        conversations: 1,
        customers: 1,
      });
    });

    it("concurrent first emails of one new sender create one customer", async () => {
      await Promise.all([deliver(mail()), deliver(mail()), deliver(mail())]);
      const c = await counts();
      expect(c.customers).toBe(1);
      expect(c.messages).toBe(3);
    });

    it("a held message is not held twice when redelivered", async () => {
      const email = mail({ senderAuth: auth.none });
      await deliver(email);
      const again = await deliver(email);
      expect(again.body.status).toBe("duplicate");
      expect((await counts()).held).toBe(1);
    });

    it("the replay ledger records outcomes but no content or addresses", async () => {
      await deliver(mail({ text: "secret content", from: "private.person@customer.test" }));
      const events = await (await db()).emailWebhookEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ outcome: "PROCESSED", reason: null });
      expect(JSON.stringify(events)).not.toMatch(/secret content|private\.person/);
    });
  });

  describe("webhook verification (never bypassed)", () => {
    it("rejects an unsigned request", async () => {
      const res = await handleInboundWebhook({ headers: {}, rawBody: "{}" });
      expect(res.status).toBe(400);
      expect(await counts()).toMatchObject({ messages: 0 });
    });

    it("rejects a forged signature, a tampered body and a stale timestamp without touching the database", async () => {
      const { webhook } = provider.receive(mail());
      const forged = {
        ...webhook,
        headers: { ...webhook.headers, "x-fake-signature": "0".repeat(64) },
      };
      expect((await handleInboundWebhook(forged)).status).toBe(401);
      const tampered = {
        ...webhook,
        rawBody: webhook.rawBody.replace(/"ref":"[^"]*"/, '"ref":"other"'),
      };
      expect((await handleInboundWebhook(tampered)).status).toBe(401);
      const stale = provider.receive(mail(), new Date(Date.now() - 3600_000));
      expect((await handleInboundWebhook(stale.webhook)).status).toBe(401);
      expect(await counts()).toMatchObject({ customers: 0, messages: 0 });
      expect(await (await db()).emailWebhookEvent.count()).toBe(0);
    });

    it("rejects a request signed with another secret (an attacker's own fake provider)", async () => {
      const attacker = new FakeEmailProvider("not-our-secret");
      const { webhook } = attacker.receive(mail());
      expect((await handleInboundWebhook(webhook)).status).toBe(401);
    });

    it("answers 404 when no provider is configured, even for a correctly formed request", async () => {
      const { webhook } = provider.receive(mail());
      setEmailProviderForTesting(undefined);
      vi.stubEnv("EMAIL_PROVIDER", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      expect((await handleInboundWebhook(webhook)).status).toBe(404);
      expect(await counts()).toMatchObject({ messages: 0 });
    });

    it("rejects an oversized body", async () => {
      const res = await handleInboundWebhook({
        headers: {},
        rawBody: "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1),
      });
      expect(res.status).toBe(413);
    });

    it("acknowledges delivery receipts without acting (outbound is a later stage)", async () => {
      const { headers, rawBody } = provider.signedWebhook({
        type: "delivery",
        id: "evt-1",
        providerMessageId: "pm-x",
        event: "bounced",
        code: "mailbox_full",
      });
      expect(await handleInboundWebhook({ headers, rawBody })).toMatchObject({
        status: 200,
        body: { status: "ignored" },
      });
    });

    it("asks the provider to retry when the message cannot be fetched yet, and records nothing", async () => {
      const { headers, rawBody } = provider.signedWebhook({
        type: "inbound",
        id: "e1",
        ref: "missing",
      });
      expect((await handleInboundWebhook({ headers, rawBody })).status).toBe(503);
      expect(await (await db()).emailWebhookEvent.count()).toBe(0);
    });

    it("a fetch failure is a server error (retried), not a lost message", async () => {
      const { webhook } = provider.receive(mail());
      vi.spyOn(provider, "fetchInboundEmail").mockRejectedValueOnce(new Error("network"));
      await expect(handleInboundWebhook(webhook)).rejects.toThrow("network");
      // The retry succeeds because nothing was recorded.
      expect((await handleInboundWebhook(webhook)).body.status).toBe("processed");
    });

    it("the HTTP route passes the raw body through and maps results to status codes", async () => {
      const { webhook } = provider.receive(mail());
      const post = (body: string, headers: Record<string, string>) =>
        (
          inboundRoute as unknown as (
            r: Request,
            c: { params: Promise<unknown> },
          ) => Promise<Response>
        )(new Request("http://localhost/api/email/inbound", { method: "POST", headers, body }), {
          params: Promise.resolve({}),
        });
      const ok = await post(webhook.rawBody, webhook.headers);
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ status: "processed" });
      const bad = await post(webhook.rawBody, { ...webhook.headers, "x-fake-signature": "00" });
      expect(bad.status).toBe(401);
      const huge = await post("x".repeat(MAX_WEBHOOK_BODY_BYTES + 10), {
        "content-length": String(MAX_WEBHOOK_BODY_BYTES + 10),
      });
      expect(huge.status).toBe(413);
    });
  });

  describe("malformed and abusive messages", () => {
    it("ignores an adapter result that violates the platform schema", async () => {
      const results = await ingestInboundEmail(mail({ text: "x".repeat(100_001) }));
      expect(results).toEqual([{ status: "ignored", reason: "malformed_message" }]);
      expect(await counts()).toMatchObject({ customers: 0, messages: 0 });
    });

    it("ignores an invalid sender address", async () => {
      const results = await ingestInboundEmail(
        mail({ from: "not an address", senderAuth: auth.none }),
      );
      expect(results).toEqual([{ status: "ignored", reason: "invalid_sender" }]);
    });

    it.each([
      ["automated mail", { automated: true }, "automated"],
      ["a bounce notice", { from: "mailer-daemon@customer.test" }, "automated"],
      ["our own platform domain (a loop)", { from: `anything@${DOMAIN}` }, "loop"],
      ["an organization's own support address", { from: ADDRESS_B }, "loop"],
    ] as const)("ignores %s", async (_label, patch, reason) => {
      const res = await deliver(mail(patch));
      expect(res.body.status).toBe("ignored");
      expect((await (await db()).emailWebhookEvent.findFirstOrThrow()).reason).toBe(reason);
      expect(await counts()).toMatchObject({
        customers: 0,
        conversations: 0,
        messages: 0,
        held: 0,
      });
    });

    it("limits one sender's volume per hour and drops the rest without storing them", async () => {
      INBOUND_LIMITS.perSender = 3;
      for (let i = 0; i < 3; i++) expect((await deliver(mail())).body.status).toBe("processed");
      const res = await deliver(mail());
      expect(res.body.status).toBe("ignored");
      expect((await counts()).messages).toBe(3);
    });

    it("limits an organization's volume per hour", async () => {
      INBOUND_LIMITS.perOrganization = 2;
      await deliver(mail({ from: "a@customer.test" }));
      await deliver(mail({ from: "b@customer.test" }));
      const res = await deliver(mail({ from: "c@customer.test" }));
      expect(res.body.status).toBe("ignored");
      expect((await counts()).customers).toBe(2);
    });

    it("caps the review queue instead of storing unbounded held mail", async () => {
      INBOUND_LIMITS.openHeldPerOrganization = 2;
      for (let i = 0; i < 4; i++) {
        await deliver(mail({ from: `s${i}@customer.test`, senderAuth: auth.none }));
      }
      expect((await counts()).held).toBe(2);
    });
  });

  describe("atomic persistence", () => {
    it("a failure while storing the email record rolls back customer, conversation and message", async () => {
      const spy = vi
        .spyOn(emailInboundRepository, "createEmailMessage")
        .mockRejectedValueOnce(new Error("disk full"));
      const { webhook } = provider.receive(mail());
      await expect(handleInboundWebhook(webhook)).rejects.toThrow("disk full");
      expect(await counts()).toMatchObject({
        customers: 0,
        conversations: 0,
        messages: 0,
        emails: 0,
      });
      expect(await (await db()).conversationEvent.count()).toBe(0);
      expect(await (await db()).emailWebhookEvent.count()).toBe(0);
      // The provider retries the same notification and it now succeeds.
      spy.mockRestore();
      expect((await handleInboundWebhook(webhook)).body.status).toBe("processed");
      expect(await counts()).toMatchObject({
        customers: 1,
        conversations: 1,
        messages: 1,
        emails: 1,
      });
    });

    it("emits no domain event for a rolled-back email", async () => {
      const events: RealtimeEvent[] = [];
      const off = subscribeRealtime(inboxChannel(t.orgA.id), (e) => events.push(e));
      vi.spyOn(emailInboundRepository, "createEmailMessage").mockRejectedValueOnce(new Error("x"));
      await expect(handleInboundWebhook(provider.receive(mail()).webhook)).rejects.toThrow();
      await tick();
      off();
      expect(events).toHaveLength(0);
    });
  });

  describe("existing semantics are preserved", () => {
    it("announces the conversation and message to the inbox in real time", async () => {
      const events: RealtimeEvent[] = [];
      const off = subscribeRealtime(inboxChannel(t.orgA.id), (e) => events.push(e));
      await deliver(mail());
      await tick(150);
      off();
      expect(events.map((e) => e.type)).toEqual(
        expect.arrayContaining(["conversation.created", "message.created"]),
      );
    });

    it("fires message.created automations for the customer's email", async () => {
      const automation = await createAutomation(
        await requireOrganizationContext(),
        automationInputSchema.parse({
          name: "on customer message",
          trigger: "message.created",
          conditions: [{ field: "senderType", operator: "equals", value: "CUSTOMER" }],
          actions: [{ type: "create_customer_note", input: { content: "fired" } }],
        }),
      );
      await deliver(mail());
      await queue.drain();
      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });

    it("never queues a customer-facing AI reply for an email conversation", async () => {
      const enqueue = vi.spyOn(queue, "enqueue");
      await deliver(mail());
      await deliver(mail({ inReplyTo: "<nope@x.test>" }));
      await queue.drain();
      expect(
        enqueue.mock.calls.filter(([job]) => "kind" in job && job.kind === "customer-ai"),
      ).toHaveLength(0);
      expect(await (await db()).message.count({ where: { senderType: "AI_AGENT" } })).toBe(0);
    });

    it("staff see the email conversation and can add an internal note; the customer message is intact", async () => {
      await deliver(mail());
      const conversation = await (await db()).conversation.findFirstOrThrow({});
      const note = await sendMessage(await requireOrganizationContext(), conversation.id, {
        body: "Looking into it",
        type: "INTERNAL_NOTE",
        from: "USER",
      });
      expect(note.messageType).toBe("INTERNAL_NOTE");
      const after = await (
        await db()
      ).conversation.findUniqueOrThrow({ where: { id: conversation.id } });
      expect(after.lastMessagePreview).toBe("My order has not arrived.");
    });
  });

  describe("database constraints (bypassing the services)", () => {
    async function stored() {
      await deliver(mail());
      const client = await db();
      return {
        client,
        email: await client.emailMessage.findFirstOrThrow({}),
        conversation: await client.conversation.findFirstOrThrow({}),
      };
    }

    const base = (email: {
      organizationId: string;
      conversationId: string;
      messageId: string;
    }) => ({
      ...email,
      direction: "INBOUND" as const,
      providerMessageId: "pm-direct",
      fromAddress: "x@y.test",
      subject: "s",
      spf: "pass",
      dkim: "pass",
      receivedAt: new Date(),
    });

    it("rejects a message id that belongs to another conversation or organization (composite FK)", async () => {
      const { client, email } = await stored();
      const eveB = await seedCustomer(t.orgB.id, { firstName: "B", email: "b@b.test" });
      const other = await seedConversation(t.orgB.id, eveB.id);
      await expect(
        client.emailMessage.create({
          data: { ...base(email), organizationId: t.orgB.id, conversationId: other.id },
        }),
      ).rejects.toThrow();
    });

    it("provider message ids are unique per organization", async () => {
      const { client, email } = await stored();
      const message = await seedMessage(t.orgA.id, email.conversationId);
      await expect(
        client.emailMessage.create({
          data: {
            ...base({ ...email, messageId: message.id }),
            providerMessageId: email.providerMessageId,
          },
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["upper-case sender", { fromAddress: "UPPER@y.test" }],
      ["bad verdict", { spf: "maybe" }],
      ["over-long subject", { subject: "x".repeat(501) }],
      ["inbound without provider id", { providerMessageId: null }],
      ["malformed Message-ID", { rfcMessageId: "no-brackets" }],
      ["whitespace in In-Reply-To", { inReplyTo: "<a b>" }],
    ])("email_messages refuses %s", async (_label, patch) => {
      const { client, email } = await stored();
      const message = await seedMessage(t.orgA.id, email.conversationId);
      await expect(
        client.emailMessage.create({
          data: { ...base({ ...email, messageId: message.id }), ...patch } as never,
        }),
      ).rejects.toThrow();
    });

    it.each([
      ["over-long body", { body: "x".repeat(10_001) }],
      ["bad verdict", { dkim: "x" }],
      ["upper-case sender", { fromAddress: "A@B.test" }],
    ])("email_held_messages refuses %s", async (_label, patch) => {
      const { client } = await stored();
      await expect(
        client.emailHeldMessage.create({
          data: {
            organizationId: t.orgA.id,
            reason: "ARCHIVED_CUSTOMER",
            providerMessageId: "held-direct",
            fromAddress: "a@b.test",
            subject: "s",
            body: "b",
            spf: "pass",
            dkim: "pass",
            receivedAt: new Date(),
            ...patch,
          },
        }),
      ).rejects.toThrow();
    });

    it("the replay ledger refuses free-text reasons", async () => {
      const client = await db();
      await expect(
        client.emailWebhookEvent.create({
          data: { replayKey: "k", outcome: "IGNORED", reason: "Provider said: no!" },
        }),
      ).rejects.toThrow();
    });

    it("deleting an organization removes its email data", async () => {
      const { client } = await stored();
      await client.organization.delete({ where: { id: t.orgA.id } });
      expect(await client.emailMessage.count()).toBe(0);
    });
  });
});
