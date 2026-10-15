import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transaction } from "@/db/client";
import { automationInputSchema } from "@/server/automation/definition";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { requireOrganizationContext } from "@/server/auth/context";
import { runAsAutomation } from "@/server/events/bus";
import {
  OUTBOX_INITIAL_LEASE_MS,
  purgePublishedOutbox,
  recordDomainEvent,
  reconcileOutbox,
} from "@/server/events/outbox";
import { metrics } from "@/server/observability/metrics";
import { automationExecutionsRepository } from "@/server/repositories/automation-executions";
import { createAutomation } from "@/server/services/automations";
import { persistMessage } from "@/server/services/conversation-messages";
import { seedConversation } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as, seedCustomer, setupTenants } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

describeDb("durable domain events (transactional outbox)", () => {
  let t: Awaited<ReturnType<typeof setupTenants>>;
  let queue: MemoryAutomationQueue;
  let customerId: string;
  let conversationId: string;
  const db = async () => (await import("@/db/client")).getDb();

  const customerMessage = (body = "hello") =>
    persistMessage({
      organizationId: t.orgA.id,
      actor: { kind: "portal", customerId },
      conversationId,
      input: { body, type: "MESSAGE", from: "CUSTOMER" },
    });

  async function automationFor(body?: string) {
    return createAutomation(
      await requireOrganizationContext(),
      automationInputSchema.parse({
        name: "on customer message",
        trigger: "message.created",
        conditions: [
          { field: "senderType", operator: "equals", value: "CUSTOMER" },
          ...(body ? [{ field: "body", operator: "contains", value: body }] : []),
        ],
        actions: [{ type: "create_customer_note", input: { content: "fired" } }],
      }),
    );
  }

  /** Makes the next automation dispatch fail the way a crash or an outage would. */
  async function breakDispatch() {
    const engine = await import("@/server/automation/engine");
    return vi.spyOn(engine, "dispatchDomainEvent").mockRejectedValue(new Error("engine down"));
  }

  const rows = async () =>
    (await db()).domainEventOutbox.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  const pastLease = () => new Date(Date.now() + OUTBOX_INITIAL_LEASE_MS + 1000);

  beforeEach(async () => {
    await resetDatabase();
    t = await setupTenants();
    queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    setAutomationQueueForTesting(queue);
    as(t.adminA);
    const customer = await seedCustomer(t.orgA.id, { firstName: "Eve", email: "eve@c.test" });
    customerId = customer.id;
    conversationId = (await seedConversation(t.orgA.id, customerId)).id;
    metrics.reset();
  });

  afterEach(() => {
    setAutomationQueueForTesting(undefined);
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await resetDatabase();
    await disconnectDatabase();
  });

  describe("recording", () => {
    it("an event commits with its change and is published right after", async () => {
      await customerMessage();
      const events = await rows();
      expect(events.map((e) => e.type)).toEqual(["message.created"]);
      expect(events[0]).toMatchObject({ organizationId: t.orgA.id, attempts: 0, lastError: null });
      expect(events[0].publishedAt).not.toBeNull();
    });

    it("a rolled-back transaction leaves no event behind", async () => {
      await expect(
        transaction(async (tx) => {
          await recordDomainEvent(tx, {
            organizationId: t.orgA.id,
            actorUserId: null,
            type: "customer.created",
            data: { customerId, status: "ACTIVE", company: null, source: null },
          });
          throw new Error("change failed");
        }),
      ).rejects.toThrow("change failed");
      expect(await rows()).toHaveLength(0);
    });

    it("the outbox never stores message text (it is read back from messages when publishing)", async () => {
      await customerMessage("my card number is 4111 1111 1111 1111");
      const [event] = await rows();
      expect(JSON.stringify(event.data)).not.toMatch(/4111|card number/);
      expect(event.data).toMatchObject({ senderType: "CUSTOMER", conversationId });
    });

    it("every channel that uses the shared message path gets durable events (reopen included)", async () => {
      await (
        await db()
      ).conversation.update({
        where: { id: conversationId },
        data: { status: "RESOLVED", closedAt: new Date() },
      });
      await customerMessage();
      expect((await rows()).map((e) => e.type)).toEqual([
        "message.created",
        "conversation.status_changed",
      ]);
    });

    it("conversation.created is durable too", async () => {
      const { createConversationCore } = await import("@/server/services/conversations");
      await createConversationCore({
        organizationId: t.orgA.id,
        actor: { kind: "portal", customerId },
        input: { customerId, subject: "New", priority: "NORMAL", channel: "PORTAL" },
      });
      const types = (await rows()).map((e) => e.type);
      expect(types).toContain("conversation.created");
      expect((await rows()).every((e) => e.publishedAt !== null)).toBe(true);
    });

    it("remembers that an automation caused the event (so a retry cannot start an automation loop)", async () => {
      await runAsAutomation("auto-1", () => customerMessage());
      const [event] = await rows();
      expect(event.causedByAutomation).toBe(true);
      await customerMessage();
      expect((await rows())[1].causedByAutomation).toBe(false);
    });
  });

  describe("publication failures", () => {
    it("a failing publisher never fails the request; the event stays for the reconciler", async () => {
      const spy = await breakDispatch();
      const { message, duplicate } = await customerMessage();
      expect(duplicate).toBe(false);
      expect(message.body).toBe("hello");
      const [event] = await rows();
      expect(event).toMatchObject({ publishedAt: null, attempts: 1, lastError: "publish_failed" });
      expect(event.leaseUntil.getTime()).toBeGreaterThan(Date.now());
      expect(spy).toHaveBeenCalled();
      expect(metrics.total("domain_event_outbox_total", { result: "failed" })).toBe(1);
    });

    it("the reconciler publishes it later with the SAME id, and the automation runs exactly once", async () => {
      const automation = await automationFor();
      let spy = await breakDispatch();
      await customerMessage();
      const [pending] = await rows();
      expect(pending.publishedAt).toBeNull();
      spy.mockRestore();

      // Not yet due: nothing to do.
      expect((await reconcileOutbox()).claimed).toBe(0);
      const result = await reconcileOutbox({ now: pastLease() });
      expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
      await queue.drain();

      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].eventId).toBe(pending.id);
      expect((await rows())[0].publishedAt).not.toBeNull();

      // Running the reconciler again (or a second worker) changes nothing.
      expect((await reconcileOutbox({ now: pastLease() })).claimed).toBe(0);
      spy = await breakDispatch();
      spy.mockRestore();
      expect(await (await db()).customerNote.count()).toBe(1);
    });

    it("a retry after the first attempt PARTLY worked does not run the automation twice", async () => {
      const automation = await automationFor();
      // The first publication got as far as recording the execution, then the process died.
      const spy = await breakDispatch();
      await customerMessage();
      spy.mockRestore();
      const [pending] = await rows();
      await automationExecutionsRepository.createIfAbsent(t.orgA.id, {
        automationId: automation.id,
        eventId: pending.id,
        eventType: "message.created",
        eventData: { messageId: "x" },
        definition: { name: "n", trigger: "message.created", conditions: [], actions: [] },
        conditionResults: [],
      });
      // An execution row exists but was never queued: a plain replay would skip it as a duplicate.
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs).toHaveLength(1);
      expect(runs[0].status).not.toBe("QUEUED");
    });

    it("a redelivery never re-runs an execution that already finished", async () => {
      const automation = await automationFor();
      await customerMessage();
      await queue.drain();
      const [event] = await rows();
      // Pretend the event was never marked published (a crash right after dispatch).
      await (
        await db()
      ).domainEventOutbox.update({
        where: { id: event.id },
        data: { publishedAt: null, leaseUntil: new Date(0) },
      });
      await reconcileOutbox();
      await queue.drain();
      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs).toHaveLength(1);
      expect(await (await db()).customerNote.count()).toBe(1);
    });

    it("message text needed by a condition is read back when the event is redelivered", async () => {
      const automation = await automationFor("refund");
      const spy = await breakDispatch();
      await customerMessage("I want a refund please");
      await customerMessage("unrelated message");
      spy.mockRestore();
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs).toHaveLength(1);
    });

    it("an event caused by an automation stays a non-trigger when redelivered", async () => {
      const automation = await automationFor();
      const spy = await breakDispatch();
      await runAsAutomation("auto-1", () => customerMessage());
      spy.mockRestore();
      await reconcileOutbox({ now: pastLease() });
      await queue.drain();
      expect(
        await (await db()).automationExecution.count({ where: { automationId: automation.id } }),
      ).toBe(0);
    });

    it("failures back off and are counted; an unknown event type is marked, not retried blindly", async () => {
      const spy = await breakDispatch();
      await customerMessage();
      const first = (await rows())[0];
      const failed = await reconcileOutbox({ now: pastLease() });
      expect(failed).toMatchObject({ claimed: 1, failed: 1 });
      const second = (await rows())[0];
      expect(second.attempts).toBe(first.attempts + 1);
      expect(second.leaseUntil.getTime()).toBeGreaterThan(Date.now());
      spy.mockRestore();

      await (
        await db()
      ).domainEventOutbox.create({
        data: {
          id: crypto.randomUUID(),
          organizationId: t.orgA.id,
          type: "something.unknown",
          data: {},
          occurredAt: new Date(),
          leaseUntil: new Date(0),
        },
      });
      await reconcileOutbox({ now: new Date(Date.now() + 10 * 3600_000) });
      const unknown = (await rows()).find((e) => e.type === "something.unknown");
      expect(unknown).toMatchObject({ publishedAt: null, lastError: "unknown_event" });
    });
  });

  describe("concurrency", () => {
    it("two reconcilers at once publish each event once and create one execution", async () => {
      const automation = await automationFor();
      const spy = await breakDispatch();
      await customerMessage();
      await customerMessage("two");
      spy.mockRestore();
      const [a, b] = await Promise.all([
        reconcileOutbox({ now: pastLease() }),
        reconcileOutbox({ now: pastLease() }),
      ]);
      expect(a.claimed + b.claimed).toBe(2);
      await queue.drain();
      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs).toHaveLength(2);
      expect(new Set(runs.map((r) => r.eventId)).size).toBe(2);
    });

    it("an event is not taken over while its recorder still holds the lease", async () => {
      const spy = await breakDispatch();
      await customerMessage();
      spy.mockRestore();
      // The failure moved the lease into the future; a reconciler now must leave it alone.
      expect((await reconcileOutbox()).claimed).toBe(0);
    });
  });

  describe("email ingestion uses the same durable path", () => {
    it("a stored inbound email whose events could not be published is recovered by the reconciler", async () => {
      vi.stubEnv("EMAIL_PLATFORM_DOMAIN", "mail.platform.test");
      vi.stubEnv("EMAIL_PROVIDER", "fake");
      const { resetServerEnvForTesting } = await import("@/lib/env");
      resetServerEnvForTesting();
      const { setEmailProviderForTesting } = await import("@/server/email");
      const { FakeEmailProvider } = await import("@/server/email/fake-provider");
      const { handleInboundWebhook } = await import("@/server/email/inbound-webhook");
      const { emailSettingsRepository } = await import("@/server/repositories/email-settings");
      const { sampleInbound } = await import("../helpers/email-provider-contract");
      const provider = new FakeEmailProvider("outbox-secret");
      setEmailProviderForTesting(provider);
      const address = "help@mail.platform.test";
      await emailSettingsRepository.create({
        organizationId: t.orgA.id,
        localPart: "help",
        supportAddress: address,
        fromName: "Support",
      });
      await emailSettingsRepository.setStatus(t.orgA.id, "ACTIVE", null);
      await emailSettingsRepository.setEnabled(t.orgA.id, true);
      const automation = await automationFor();

      const spy = await breakDispatch();
      const email = sampleInbound({
        providerMessageId: "outbox-1",
        messageId: "<o1@customer.test>",
        from: "newcustomer@customer.test",
        deliveredTo: [address],
        to: [address],
      });
      const { webhook } = provider.receive(email);
      const res = await handleInboundWebhook(webhook);
      expect(res).toMatchObject({ status: 200, body: { status: "processed" } });
      spy.mockRestore();

      const pending = (await rows()).filter((e) => e.publishedAt === null);
      expect(pending.map((e) => e.type).sort()).toEqual([
        "conversation.created",
        "customer.created",
        "message.created",
      ]);

      // The provider's retry is a duplicate and announces nothing; the reconciler delivers the events.
      expect((await handleInboundWebhook(webhook)).body.status).toBe("duplicate");
      const done = await reconcileOutbox({ now: pastLease() });
      expect(done).toMatchObject({ claimed: 3, published: 3, failed: 0 });
      await queue.drain();
      expect(
        await (await db()).automationExecution.count({ where: { automationId: automation.id } }),
      ).toBe(1);
      expect((await rows()).every((e) => e.publishedAt !== null)).toBe(true);
      setEmailProviderForTesting(undefined);
      vi.unstubAllEnvs();
    });
  });

  describe("retention", () => {
    it("removes only PUBLISHED events older than the retention; unpublished events are never purged", async () => {
      const client = await db();
      const day = 24 * 3600_000;
      const base = {
        organizationId: t.orgA.id,
        type: "message.created",
        data: {},
        leaseUntil: new Date(0),
      };
      const old = new Date(Date.now() - 30 * day);
      await client.domainEventOutbox.createMany({
        data: [
          { ...base, id: crypto.randomUUID(), occurredAt: old, createdAt: old, publishedAt: old },
          { ...base, id: crypto.randomUUID(), occurredAt: old, createdAt: old, publishedAt: null },
          { ...base, id: crypto.randomUUID(), occurredAt: new Date(), publishedAt: new Date() },
        ],
      });
      expect(await purgePublishedOutbox()).toBe(1);
      expect(await client.domainEventOutbox.count()).toBe(2);
      await expect(purgePublishedOutbox({ olderThanDays: 0 })).rejects.toThrow();
    });

    it("rejects invalid rows at the database (type format, attempts, error code)", async () => {
      const client = await db();
      const base = {
        id: crypto.randomUUID(),
        organizationId: t.orgA.id,
        type: "message.created",
        data: {},
        occurredAt: new Date(),
        leaseUntil: new Date(),
      };
      await expect(
        client.domainEventOutbox.create({ data: { ...base, type: "Bad Type!" } }),
      ).rejects.toThrow();
      await expect(
        client.domainEventOutbox.create({
          data: { ...base, id: crypto.randomUUID(), attempts: -1 },
        }),
      ).rejects.toThrow();
      await expect(
        client.domainEventOutbox.create({
          data: { ...base, id: crypto.randomUUID(), lastError: "Free text: boom" },
        }),
      ).rejects.toThrow();
    });
  });
});
