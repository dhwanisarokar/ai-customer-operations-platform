import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as emailReplyRoute } from "@/app/api/conversations/[conversationId]/email-reply/route";
import {
  GET as messagesGet,
  POST as messagesPost,
} from "@/app/api/conversations/[conversationId]/messages/route";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { setEmailProviderForTesting } from "@/server/email";
import { FakeEmailProvider, NO_SENDING_GUARANTEES } from "@/server/email/fake-provider";
import { handleInboundWebhook } from "@/server/email/inbound-webhook";
import { processEmailSendJob, reconcileOutboundEmail } from "@/server/email/outbound";
import { inboxChannel } from "@/server/realtime/channels";
import type { RealtimeEvent } from "@/server/realtime/events";
import { subscribeRealtime } from "@/server/realtime/publisher";
import { emailSettingsRepository } from "@/server/repositories/email-settings";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { persistMessage } from "@/server/services/conversation-messages";
import { call } from "../helpers/api";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { sampleInbound } from "../helpers/email-provider-contract";
import { signOut } from "../helpers/mocks";
import { RecordingQueue } from "../helpers/recording-queue";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const DOMAIN = "mail.platform.test";
const ADDRESS_A = `help-a@${DOMAIN}`;
const uuid = () => crypto.randomUUID();

describeDb("staff inbox: replying by email and seeing delivery state", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let provider: FakeEmailProvider;
  let queue: RecordingQueue;
  let customerId: string;
  let conversationId: string;
  const db = async () => (await import("@/db/client")).getDb();

  async function emailConversation(
    organizationId: string,
    customer: string,
    subject = "Order help",
    channel = "EMAIL",
  ) {
    const client = await db();
    return (
      await client.conversation.create({
        data: {
          organizationId,
          customerId: customer,
          subject,
          channel: channel as never,
          lastMessageAt: new Date(),
        },
      })
    ).id;
  }
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

  const reply = (body: unknown, cid = conversationId) =>
    call(emailReplyRoute, { method: "POST", params: { conversationId: cid }, body });
  const goodReply = (over: Record<string, unknown> = {}, cid = conversationId) =>
    reply({ body: "Your order shipped today.", clientMessageId: uuid(), ...over }, cid);
  const plain = (body: unknown, cid = conversationId) =>
    call(messagesPost, { method: "POST", params: { conversationId: cid }, body });
  const list = (cid = conversationId) =>
    call(messagesGet, {
      params: { conversationId: cid },
      query: { includeInternal: "true", limit: "50" },
    });
  const run = (sendId: string, over = {}) =>
    processEmailSendJob(
      { kind: "email-send", executionId: `x-${sendId}`, organizationId: t.orgA.id, sendId },
      over,
    );
  const sendOf = async (messageId: string) =>
    (await db()).outboundEmail.findUniqueOrThrow({ where: { messageId } });
  const deliveryOf = async (messageId: string, cid = conversationId) => {
    const res = await list(cid);
    return res.body.items.find((m: { id: string }) => m.id === messageId)?.emailDelivery;
  };

  beforeEach(async () => {
    vi.stubEnv("EMAIL_PLATFORM_DOMAIN", DOMAIN);
    vi.stubEnv("EMAIL_PROVIDER", "fake");
    const { resetServerEnvForTesting } = await import("@/lib/env");
    resetServerEnvForTesting();
    await resetDatabase();
    t = await setupTenants();
    provider = new FakeEmailProvider("inbox-secret");
    setEmailProviderForTesting(provider);
    queue = new RecordingQueue();
    setAutomationQueueForTesting(queue);
    await enableEmail(t.orgA.id, ADDRESS_A);
    customerId = (await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@customer.test" }))
      .id;
    conversationId = await emailConversation(t.orgA.id, customerId);
    as(t.adminA);
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

  // ---- 1-3. who may send what ---------------------------------------------------------------------------

  describe("sending an email reply", () => {
    it.each([
      ["an admin", () => as(t.adminA)],
      ["a member", () => as(t.memberA)],
      ["an owner", () => as(t.ownerA)],
    ])(
      "%s can send an eligible reply: stored with its send, queued, NOT sent from the request",
      async (_who, signIn) => {
        signIn();
        const res = await goodReply({ body: "Your order shipped today." });
        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
          duplicate: false,
          delivery: { state: "queued" },
        });
        expect(res.body.message).toMatchObject({
          senderType: "USER",
          messageType: "MESSAGE",
          body: "Your order shipped today.",
        });

        const send = await sendOf(res.body.message.id);
        expect(send).toMatchObject({
          organizationId: t.orgA.id,
          conversationId,
          status: "PENDING",
          toAddress: "eve@customer.test",
          fromAddress: ADDRESS_A,
        });
        // The request never touched the provider; it queued an ids-only wake-up.
        expect(provider.sendCalls).toBe(0);
        expect(queue.emailJobs()).toHaveLength(1);
        expect(JSON.stringify(queue.jobs)).not.toMatch(/shipped|eve@customer|Order help/);
      },
    );

    it("delivery through the worker is then visible as accepted by the provider (not as delivered)", async () => {
      const res = await goodReply();
      await run((await sendOf(res.body.message.id)).id);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0]).toMatchObject({
        to: "eve@customer.test",
        from: { address: ADDRESS_A, name: "Acme Support" },
        text: "Your order shipped today.",
      });
      const delivery = await deliveryOf(res.body.message.id);
      expect(delivery).toMatchObject({
        state: "accepted",
        failure: null,
        retryAt: null,
        failedAt: null,
      });
      expect(delivery.acceptedAt).toEqual(expect.any(String));
      // Nothing in the payload claims delivery.
      expect(JSON.stringify(delivery)).not.toMatch(/deliver/i);
    });

    it("requires authentication", async () => {
      signOut();
      expect((await goodReply()).status).toBe(401);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });

    it("an internal note on an email conversation is never emailed", async () => {
      const res = await plain({
        body: "Customer is angry, be careful",
        type: "INTERNAL_NOTE",
        from: "USER",
      });
      expect(res.status).toBe(201);
      expect(await (await db()).outboundEmail.count()).toBe(0);
      expect(queue.jobs).toHaveLength(0);
      expect(provider.sendCalls).toBe(0);
      const items = (await list()).body.items;
      const note = items.find((m: { messageType: string }) => m.messageType === "INTERNAL_NOTE");
      expect(note.emailDelivery ?? null).toBeNull();
    });

    it("logging what the customer said (a message FROM the customer) is not emailed either", async () => {
      const res = await plain({
        body: "They phoned to say hello",
        type: "MESSAGE",
        from: "CUSTOMER",
      });
      expect(res.status).toBe(201);
      expect(await (await db()).outboundEmail.count()).toBe(0);
      expect(queue.jobs).toHaveLength(0);
    });

    it("the plain message path REFUSES a customer-facing staff reply on an email conversation (it would never be sent)", async () => {
      const before = await (await db()).message.count();
      const res = await plain({ body: "Looks sent, but is not", type: "MESSAGE", from: "USER" });
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/send replies by email/i);
      expect(await (await db()).message.count()).toBe(before);
    });
  });

  // ---- 3. other channels unchanged ----------------------------------------------------------------------

  describe("other channels keep their behavior", () => {
    it.each(["IN_APP", "WEB_CHAT", "PORTAL"])(
      "a staff reply on a %s conversation still works through the plain path",
      async (channel) => {
        const cid = await emailConversation(t.orgA.id, customerId, `Thread ${channel}`, channel);
        const res = await plain({ body: "Reply", type: "MESSAGE", from: "USER" }, cid);
        expect(res.status).toBe(201);
        expect(res.body.message.body).toBe("Reply");
        expect(await (await db()).outboundEmail.count()).toBe(0);
        expect(queue.jobs).toHaveLength(0);
        // And their message payload has no email delivery field at all.
        const items = (await list(cid)).body.items;
        expect(items.every((m: object) => !("emailDelivery" in m))).toBe(true);
      },
    );

    it("the email-reply endpoint refuses a conversation that is not an email conversation", async () => {
      const cid = await emailConversation(t.orgA.id, customerId, "Chat", "WEB_CHAT");
      const res = await goodReply({}, cid);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/email conversations/i);
      expect(await (await db()).message.count({ where: { conversationId: cid } })).toBe(0);
    });
  });

  // ---- 4. eligibility -----------------------------------------------------------------------------------

  describe("email settings decide whether it can be sent", () => {
    const refused = async () => {
      const before = await (await db()).message.count();
      const res = await goodReply();
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/not set up/i);
      expect(await (await db()).message.count()).toBe(before); // the message was rolled back too
      expect(await (await db()).outboundEmail.count()).toBe(0);
      expect(queue.jobs).toHaveLength(0);
    };

    it("disabled", async () => {
      await emailSettingsRepository.setEnabled(t.orgA.id, false);
      await refused();
    });
    it("not verified (pending)", async () => {
      await emailSettingsRepository.setStatus(t.orgA.id, "PENDING_VERIFICATION", null);
      await refused();
    });
    it("verification failed", async () => {
      await emailSettingsRepository.setStatus(t.orgA.id, "FAILED", "provider_error");
      await refused();
    });
    it("no settings at all", async () => {
      await (await db()).emailSettings.deleteMany({ where: { organizationId: t.orgA.id } });
      await refused();
    });
    it("the platform has no provider", async () => {
      setEmailProviderForTesting(undefined);
      vi.stubEnv("EMAIL_PROVIDER", "");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      await refused();
    });

    it("a customer without an email address cannot be emailed", async () => {
      const noMail = await seedCustomer(t.orgA.id, { firstName: "NoMail", email: null });
      const cid = await emailConversation(t.orgA.id, noMail.id);
      const res = await goodReply({}, cid);
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toMatch(/no email address/i);
    });

    it("a resolved conversation must be reopened first, like any reply", async () => {
      await (
        await db()
      ).conversation.update({
        where: { id: conversationId },
        data: { status: "RESOLVED", closedAt: new Date() },
      });
      const res = await goodReply();
      expect(res.status).toBe(409);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });
  });

  // ---- 5-6. tenancy and untrusted input -----------------------------------------------------------------

  describe("tenant isolation and untrusted input", () => {
    it("another organization's staff cannot reply to this conversation (it does not exist for them)", async () => {
      await enableEmail(t.orgB.id, `help-b@${DOMAIN}`);
      as(t.ownerB);
      const res = await goodReply();
      expect(res.status).toBe(404);
      expect(await (await db()).outboundEmail.count()).toBe(0);
      expect(await (await db()).message.count({ where: { conversationId } })).toBe(0);
    });

    it("an organization-B conversation is unreachable from organization A, even with a valid-looking id", async () => {
      await enableEmail(t.orgB.id, `help-b@${DOMAIN}`);
      const customerB = await seedCustomer(t.orgB.id, {
        firstName: "Bob",
        email: "bob@customer.test",
      });
      const conversationB = await emailConversation(t.orgB.id, customerB.id, "Bob");
      as(t.adminA);
      expect((await goodReply({}, conversationB)).status).toBe(404);
      expect((await list(conversationB)).status).toBe(404);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });

    it.each([
      ["a recipient", { to: "attacker@evil.test" }],
      ["a recipient list", { recipients: ["attacker@evil.test"] }],
      ["a sender address", { from: "ceo@victim.test" }],
      ["a sender address (camelCase)", { fromAddress: "ceo@victim.test" }],
      ["a sender name", { fromName: "The CEO" }],
      ["an organization id", { organizationId: crypto.randomUUID() }],
      ["a customer id", { customerId: crypto.randomUUID() }],
      ["a subject", { subject: "Totally legit" }],
      ["a Message-ID", { messageId: "<forged@evil.test>" }],
      ["an In-Reply-To", { inReplyTo: "<forged@evil.test>" }],
      ["References", { references: ["<forged@evil.test>"] }],
      ["CC", { cc: ["attacker@evil.test"] }],
      ["a message type", { type: "INTERNAL_NOTE" }],
      ["an author", { senderType: "CUSTOMER" }],
    ])(
      "rejects %s from the client (the schema is strict) and creates nothing",
      async (_label, extra) => {
        const res = await goodReply(extra);
        expect(res.status).toBe(400);
        expect(await (await db()).message.count({ where: { conversationId } })).toBe(0);
        expect(await (await db()).outboundEmail.count()).toBe(0);
        expect(queue.jobs).toHaveLength(0);
      },
    );

    it.each([
      ["no key", { clientMessageId: undefined }],
      ["a key that is not a UUID", { clientMessageId: "not-a-uuid" }],
      ["an empty body", { body: "   " }],
      ["a missing body", { body: undefined }],
      ["an oversized body", { body: "x".repeat(10_001) }],
    ])("rejects %s", async (_label, over) => {
      expect((await goodReply(over)).status).toBe(400);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });

    it("the recipient and sender always come from the persisted records, whatever the client sends or the customer's name says", async () => {
      const res = await goodReply({ body: "Hello" });
      const send = await sendOf(res.body.message.id);
      expect(send.toAddress).toBe("eve@customer.test");
      expect(send.fromAddress).toBe(ADDRESS_A);
      await run(send.id);
      expect(provider.sent).toHaveLength(1);
      expect(provider.sent[0].to).toBe("eve@customer.test");
    });

    it("the email goes from the organization's OWN verified address, never another organization's", async () => {
      await enableEmail(t.orgB.id, `help-b@${DOMAIN}`);
      const res = await goodReply();
      await run((await sendOf(res.body.message.id)).id);
      expect(provider.sent[0].from.address).toBe(ADDRESS_A);
      expect(provider.sent[0].from.address).not.toContain("help-b");
    });
  });

  // ---- 7-8. idempotency ---------------------------------------------------------------------------------

  describe("idempotent requests", () => {
    it("a repeated request returns the original and creates and queues nothing", async () => {
      const key = uuid();
      const first = await goodReply({ clientMessageId: key });
      const second = await goodReply({ clientMessageId: key });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ duplicate: true });
      expect(second.body.message.id).toBe(first.body.message.id);
      const client = await db();
      expect(await client.message.count({ where: { conversationId, senderType: "USER" } })).toBe(1);
      expect(await client.outboundEmail.count()).toBe(1);
      expect(queue.emailJobs()).toHaveLength(1);
    });

    it("a repeat after the email was already sent does not queue or send anything again", async () => {
      const key = uuid();
      const first = await goodReply({ clientMessageId: key });
      await run((await sendOf(first.body.message.id)).id);
      queue.clear();
      const again = await goodReply({ clientMessageId: key });
      expect(again.status).toBe(200);
      expect(again.body.delivery.state).toBe("accepted"); // the current persisted state, not a new send
      expect(queue.jobs).toHaveLength(0);
      expect(provider.sendCalls).toBe(1);
      expect(provider.sent).toHaveLength(1);
      expect(await (await db()).outboundEmail.count()).toBe(1);
    });

    it("concurrent identical requests (a double click, two tabs) create exactly one logical send", async () => {
      const key = uuid();
      const results = await Promise.all(
        Array.from({ length: 6 }, () => goodReply({ clientMessageId: key })),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 200)).toHaveLength(5);
      expect(new Set(results.map((r) => r.body.message.id)).size).toBe(1);
      const client = await db();
      expect(await client.message.count({ where: { conversationId, senderType: "USER" } })).toBe(1);
      expect(await client.outboundEmail.count()).toBe(1);
      expect(queue.emailJobs()).toHaveLength(1);
    });

    it("a browser retry after a lost response (same key) is the same send, even after delivery moved on", async () => {
      const key = uuid();
      const first = await goodReply({ clientMessageId: key });
      provider.failNextSend({ retryable: true });
      await run((await sendOf(first.body.message.id)).id);
      const retry = await goodReply({ clientMessageId: key });
      expect(retry.body.duplicate).toBe(true);
      expect(retry.body.delivery.state).toBe("retrying");
      expect(await (await db()).outboundEmail.count()).toBe(1);
    });

    it("different keys are different replies", async () => {
      await goodReply({ clientMessageId: uuid(), body: "One" });
      await goodReply({ clientMessageId: uuid(), body: "Two" });
      expect(await (await db()).outboundEmail.count()).toBe(2);
    });

    it("the same key with DIFFERENT content is refused, not answered with the earlier message", async () => {
      const key = uuid();
      await goodReply({ clientMessageId: key, body: "Original" });
      const res = await goodReply({ clientMessageId: key, body: "Something else" });
      expect(res.status).toBe(409);
      expect(await (await db()).outboundEmail.count()).toBe(1);
    });

    it("the same key from ANOTHER staff member is refused (no one gets another person's record)", async () => {
      const key = uuid();
      as(t.adminA);
      await goodReply({ clientMessageId: key });
      as(t.memberA);
      const res = await goodReply({ clientMessageId: key });
      expect(res.status).toBe(409);
      expect(await (await db()).outboundEmail.count()).toBe(1);
    });

    it("a key already used by a message that is not an email reply is refused", async () => {
      const key = uuid();
      await (
        await import("@/server/services/conversation-messages")
      ).persistMessage({
        organizationId: t.orgA.id,
        actor: { kind: "user", userId: t.adminA.id },
        conversationId,
        input: { body: "Your order shipped today.", type: "MESSAGE", from: "CUSTOMER" },
        clientMessageId: key,
      });
      const res = await goodReply({ clientMessageId: key });
      expect(res.status).toBe(409);
      expect(await (await db()).outboundEmail.count()).toBe(0);
    });

    it("the same key in a DIFFERENT conversation is an independent reply", async () => {
      const key = uuid();
      const other = await emailConversation(t.orgA.id, customerId, "Another thread");
      expect((await goodReply({ clientMessageId: key })).status).toBe(201);
      expect((await goodReply({ clientMessageId: key }, other)).status).toBe(201);
      expect(await (await db()).outboundEmail.count()).toBe(2);
    });
  });

  // ---- 9-12. delivery state in the inbox ----------------------------------------------------------------

  describe("delivery state as staff see it", () => {
    async function sent() {
      const res = await goodReply();
      return {
        messageId: res.body.message.id as string,
        sendId: (await sendOf(res.body.message.id)).id,
      };
    }

    it("queued: nobody has picked it up (also what staff see when no worker is running)", async () => {
      const { messageId } = await sent();
      expect(await deliveryOf(messageId)).toMatchObject({
        state: "queued",
        acceptedAt: null,
        retryAt: null,
        failure: null,
      });
    });

    it("sending: a worker holds the claim right now", async () => {
      const { messageId, sendId } = await sent();
      await outboundEmailRepository.claim(
        sendId,
        t.orgA.id,
        new Date(),
        new Date(Date.now() + 60_000),
      );
      expect(await deliveryOf(messageId)).toMatchObject({ state: "sending" });
    });

    it("accepted: provider acceptance, with a time, and no claim of delivery", async () => {
      const { messageId, sendId } = await sent();
      await run(sendId);
      const delivery = await deliveryOf(messageId);
      expect(delivery).toMatchObject({ state: "accepted", failure: null });
      expect(delivery.acceptedAt).not.toBeNull();
    });

    it("retrying: a temporary failure with the time of the next attempt", async () => {
      const { messageId, sendId } = await sent();
      provider.failNextSend({ retryable: true, code: "rate_limited" });
      await run(sendId);
      const delivery = await deliveryOf(messageId);
      expect(delivery).toMatchObject({
        state: "retrying",
        acceptedAt: null,
        failure: null,
      });
      expect(new Date(delivery.retryAt).getTime()).toBeGreaterThan(Date.now());
    });

    it("failed (rejected): a definite refusal, with a coarse reason and no provider detail", async () => {
      const { messageId, sendId } = await sent();
      provider.failNextSend({ retryable: false, code: "mailbox_invalid" });
      await run(sendId);
      const delivery = await deliveryOf(messageId);
      expect(delivery).toMatchObject({
        state: "failed",
        failure: "rejected",
        acceptedAt: null,
        retryAt: null,
      });
      expect(JSON.stringify(delivery)).not.toContain("mailbox_invalid");
    });

    it("failed (retries exhausted)", async () => {
      const { messageId, sendId } = await sent();
      provider.failNextSend({ retryable: true });
      await run(sendId, { maxAttempts: 1 });
      expect(await deliveryOf(messageId)).toMatchObject({
        state: "failed",
        failure: "retries_exhausted",
      });
    });

    it("failed (email switched off before it was sent)", async () => {
      const { messageId, sendId } = await sent();
      await emailSettingsRepository.setEnabled(t.orgA.id, false);
      await run(sendId);
      expect(await deliveryOf(messageId)).toMatchObject({
        state: "failed",
        failure: "sender_unavailable",
      });
      expect(provider.sendCalls).toBe(0);
    });

    it("UNKNOWN is shown as uncertain: neither accepted nor failed, and it is never resent", async () => {
      provider.sending = NO_SENDING_GUARANTEES;
      const { messageId, sendId } = await sent();
      provider.ambiguousNextSend({ delivered: true });
      await run(sendId);
      const delivery = await deliveryOf(messageId);
      expect(delivery).toMatchObject({
        state: "unknown",
        acceptedAt: null,
        failedAt: null,
        failure: null,
        retryAt: null,
      });
      await run(sendId);
      await reconcileOutboundEmail({ now: () => new Date(Date.now() + 24 * 3600_000) });
      expect(provider.sendCalls).toBe(1);
      expect((await deliveryOf(messageId)).state).toBe("unknown");
    });

    it("a provider success whose database update failed is not shown as accepted until it is proven", async () => {
      const { messageId, sendId } = await sent();
      vi.spyOn(outboundEmailRepository, "markSent").mockRejectedValueOnce(new Error("db down"));
      await run(sendId);
      expect(provider.sent).toHaveLength(1);
      expect((await deliveryOf(messageId)).state).toBe("sending"); // honest: still in flight
      await reconcileOutboundEmail({ now: () => new Date(Date.now() + 10 * 60_000) });
      expect((await deliveryOf(messageId)).state).toBe("accepted"); // proven by the lookup
      expect(provider.sent).toHaveLength(1);
    });

    it("exposes nothing sensitive: no provider id, raw codes, addresses, Message-IDs or leases", async () => {
      const { messageId, sendId } = await sent();
      provider.failNextSend({ retryable: true, code: "rate_limited" });
      await run(sendId);
      await run(sendId, { now: () => new Date(Date.now() + 3600_000) });
      const item = (await list()).body.items.find((m: { id: string }) => m.id === messageId);
      const dump = JSON.stringify(item.emailDelivery);
      // The ownership (fencing) counter is internal and never part of the payload.
      expect(item.emailDelivery).not.toHaveProperty("attempts");
      expect(Object.keys(item.emailDelivery).sort()).toEqual([
        "acceptedAt",
        "failedAt",
        "failure",
        "retryAt",
        "state",
      ]);
      expect(dump).not.toMatch(
        /fake-|rate_limited|eve@customer|help-a|@mail\.platform|leaseUntil|providerMessageId|rfcMessageId/,
      );
    });

    it("is visible only to authorized users of the right organization", async () => {
      const { messageId } = await sent();
      expect((await deliveryOf(messageId)).state).toBe("queued");
      signOut();
      expect((await list()).status).toBe(401);
      await enableEmail(t.orgB.id, `help-b@${DOMAIN}`);
      as(t.ownerB);
      expect((await list()).status).toBe(404);
    });

    it("internal notes and customer messages in the same conversation carry no delivery state", async () => {
      await sent();
      await plain({ body: "note", type: "INTERNAL_NOTE", from: "USER" });
      const items = (await list()).body.items;
      const withDelivery = items.filter((m: { emailDelivery?: unknown }) => m.emailDelivery);
      expect(withDelivery).toHaveLength(1);
      expect(withDelivery[0].senderType).toBe("USER");
      expect(withDelivery[0].messageType).toBe("MESSAGE");
    });
  });

  // ---- realtime -----------------------------------------------------------------------------------------

  describe("realtime", () => {
    it("announces the new message and every delivery change to the organization's staff only, as content-free hints", async () => {
      await enableEmail(t.orgB.id, `help-b@${DOMAIN}`);
      const eventsA: RealtimeEvent[] = [];
      const eventsB: RealtimeEvent[] = [];
      const offA = subscribeRealtime(inboxChannel(t.orgA.id), (e) => eventsA.push(e));
      const offB = subscribeRealtime(inboxChannel(t.orgB.id), (e) => eventsB.push(e));
      const res = await goodReply({ body: "Private reply text" });
      await vi.waitFor(() => expect(eventsA.some((e) => e.type === "message.created")).toBe(true));
      const sendId = (await sendOf(res.body.message.id)).id;
      eventsA.length = 0;
      await run(sendId);
      await vi.waitFor(() =>
        expect(
          eventsA.some(
            (e) => e.type === "conversation.updated" && e.conversationId === conversationId,
          ),
        ).toBe(true),
      );
      offA();
      offB();
      expect(eventsB).toHaveLength(0);
      expect(JSON.stringify(eventsA)).not.toMatch(/Private reply|eve@customer|accepted/);
    });

    it("the message events still go through the durable outbox, as for every other channel", async () => {
      const res = await goodReply();
      const events = await (
        await db()
      ).domainEventOutbox.findMany({ where: { organizationId: t.orgA.id } });
      expect(events.map((e) => e.type)).toContain("message.created");
      expect(events.find((e) => e.type === "message.created")?.data).toMatchObject({
        messageId: res.body.message.id,
        senderType: "USER",
        messageType: "MESSAGE",
      });
    });
  });

  // ---- threading ----------------------------------------------------------------------------------------

  describe("threading through the inbox", () => {
    it("replies inside the customer's thread and the customer's answer lands in the same conversation", async () => {
      const inbound = async (over = {}) => {
        const email = sampleInbound({
          providerMessageId: `in-${uuid()}`,
          from: "eve@customer.test",
          fromName: "Eve",
          deliveredTo: [ADDRESS_A],
          to: [ADDRESS_A],
          subject: "Where is my parcel",
          text: "Any news?",
          ...over,
        });
        expect((await handleInboundWebhook(provider.receive(email).webhook)).body.status).toBe(
          "processed",
        );
      };
      await inbound({ messageId: "<c1@customer.test>" });
      const client = await db();
      const thread = await client.conversation.findFirstOrThrow({
        where: { organizationId: t.orgA.id, subject: "Where is my parcel" },
      });
      const res = await goodReply({}, thread.id);
      expect(res.status).toBe(201);
      const send = await sendOf(res.body.message.id);
      expect(send).toMatchObject({
        inReplyTo: "<c1@customer.test>",
        references: ["<c1@customer.test>"],
      });
      await run(send.id);
      expect(provider.sent[0]).toMatchObject({
        inReplyTo: "<c1@customer.test>",
        messageId: send.rfcMessageId,
      });

      await inbound({
        messageId: "<c2@customer.test>",
        inReplyTo: send.rfcMessageId,
        subject: "Something unrelated",
        text: "Thanks",
      });
      expect(
        await client.message.count({
          where: { conversationId: thread.id, senderType: "CUSTOMER" },
        }),
      ).toBe(2);
      expect(
        await client.conversation.count({
          where: { organizationId: t.orgA.id, subject: "Something unrelated" },
        }),
      ).toBe(0);
    });
  });

  // ---- no regression in the non-email conversation message path -----------------------------------------

  describe("the plain message path is otherwise untouched", () => {
    it("lists and sends exactly as before for an in-app conversation", async () => {
      const cid = await emailConversation(t.orgA.id, customerId, "Internal", "IN_APP");
      const a = await plain({ body: "Hello", type: "MESSAGE", from: "USER" }, cid);
      const b = await plain({ body: "Note", type: "INTERNAL_NOTE", from: "USER" }, cid);
      expect([a.status, b.status]).toEqual([201, 201]);
      const items = (await list(cid)).body.items;
      expect(items.map((m: { body: string }) => m.body)).toEqual(["Hello", "Note"]);
    });

    it("persistMessage for a portal/web-chat style actor on an email conversation is not affected by the staff guard", async () => {
      const { message } = await persistMessage({
        organizationId: t.orgA.id,
        actor: { kind: "portal", customerId },
        conversationId,
        input: { body: "Customer wrote", type: "MESSAGE", from: "CUSTOMER" },
      });
      expect(message.senderType).toBe("CUSTOMER");
    });
  });
});
