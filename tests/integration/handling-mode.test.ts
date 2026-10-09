import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as handlingRoute } from "@/app/api/conversations/[conversationId]/handling/route";
import { POST as aiDraftRoute } from "@/app/api/conversations/[conversationId]/ai-draft/route";
import { POST as messagePost } from "@/app/api/widget/conversations/[conversationId]/messages/route";
import { POST as handoffPost } from "@/app/api/widget/conversations/[conversationId]/handoff/route";
import { GET as conversationGet } from "@/app/api/widget/conversations/[conversationId]/route";
import { POST as conversationsPost } from "@/app/api/widget/conversations/route";
import { POST as sessionPost } from "@/app/api/widget/session/route";
import { transaction } from "@/db/client";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import type { QueueJob } from "@/server/automation/queue/types";
import { requireOrganizationContext } from "@/server/auth/context";
import { MemoryRateLimiter, setRateLimiterForTesting } from "@/server/rate-limit";
import { conversationsRepository } from "@/server/repositories/conversations";
import { persistMessage, sendMessage } from "@/server/services/conversation-messages";
import { setHandlingMode } from "@/server/services/conversation-handling";
import { assignConversation, updateConversation } from "@/server/services/conversations";
import { processCustomerAiJob } from "@/server/services/customer-ai";
import { getWidgetSettings, updateWidgetSettings } from "@/server/widget/settings";
import { installFakeAi, modelJson, uninstallFakeAi, type FakeAiProvider } from "../helpers/ai";
import { call } from "../helpers/api";
import { seedConversation } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { REFUND_DOC, createPublishedDocument, setupAiTenants } from "../helpers/knowledge";
import { signOut } from "../helpers/mocks";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;
async function widgetCall(
  handler: unknown,
  options: {
    token?: string;
    method?: string;
    body?: unknown;
    params?: Record<string, string>;
  } = {},
) {
  const { token, method = "GET", body, params = {} } = options;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": "1.1.1.1",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await (handler as Handler)(
    new Request("http://localhost/api/widget/test", {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) as Promise<never> },
  );
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const uuid = () => crypto.randomUUID();
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const REFUND_Q = "What is your refund policy?";
const UNKNOWN = modelJson({
  answerable: false,
  reply: "I don't have information on that.",
  sourceLabels: [],
});

describeDb("conversation handling mode (AI | HUMAN)", () => {
  let t: Awaited<ReturnType<typeof setupAiTenants>>;
  let fake: FakeAiProvider;
  let queue: MemoryAutomationQueue;
  let key: string;
  let enqueued: QueueJob[];

  const db = async () => (await import("@/db/client")).getDb();
  const ctxOf = async (user: { authProviderId: string }) => {
    as(user);
    return requireOrganizationContext();
  };

  async function configureWidget(user: { authProviderId: string }, ai = true) {
    const ctx = await ctxOf(user);
    const current = await getWidgetSettings(ctx);
    await updateWidgetSettings(ctx, {
      enabled: true,
      displayName: "Support",
      welcomeMessage: "Hi",
      accentColor: null,
      allowedOrigins: [],
      aiRepliesEnabled: ai,
    });
    return current.publicKey;
  }
  async function session(widgetKey = key) {
    const r = await widgetCall(sessionPost, { method: "POST", body: { key: widgetKey } });
    return r.body.token as string;
  }
  async function chat(token: string, body = REFUND_Q) {
    const r = await widgetCall(conversationsPost, {
      token,
      method: "POST",
      body: { body, clientMessageId: uuid() },
    });
    await queue.drain();
    return r.body.conversation.id as string;
  }
  async function say(token: string, conversationId: string, body: string) {
    await widgetCall(messagePost, {
      token,
      method: "POST",
      params: { conversationId },
      body: { body, clientMessageId: uuid() },
    });
    await queue.drain();
  }
  const row = async (id: string) => (await db()).conversation.findUniqueOrThrow({ where: { id } });
  const mode = async (id: string) => (await row(id)).handlingMode;
  const aiCount = async (id: string) =>
    (await db()).message.count({ where: { conversationId: id, senderType: "AI_AGENT" } });
  const modeEvents = async (id: string) =>
    (await (await db()).conversationEvent.findMany({ where: { conversationId: id } })).filter(
      (e) => e.type === "HANDLING_MODE_CHANGED",
    );
  const totalMessages = async (id: string) =>
    (await db()).message.count({ where: { conversationId: id } });
  const view = async (token: string, id: string) =>
    (await widgetCall(conversationGet, { token, params: { conversationId: id } })).body;

  beforeEach(async () => {
    await resetDatabase();
    t = await setupAiTenants();
    fake = installFakeAi();
    setRateLimiterForTesting(new MemoryRateLimiter());
    queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    enqueued = [];
    const original = queue.enqueue.bind(queue);
    queue.enqueue = async (job) => {
      enqueued.push(job);
      return original(job);
    };
    setAutomationQueueForTesting(queue);
    await createPublishedDocument(await ctxOf(t.adminA), REFUND_DOC);
    await createPublishedDocument(await ctxOf(t.ownerB), { title: "Other", content: "B only." });
    key = await configureWidget(t.adminA);
  });
  afterEach(() => {
    uninstallFakeAi();
    setRateLimiterForTesting(undefined);
    setAutomationQueueForTesting(undefined);
  });
  afterAll(disconnectDatabase);

  describe("initial mode", () => {
    it("a new web chat starts in AI mode when customer AI is enabled, and the AI answers", async () => {
      const token = await session();
      const id = await chat(token);
      expect(await mode(id)).toBe("AI");
      expect(await aiCount(id)).toBe(1);
      expect((await view(token, id)).conversation.assistant).toBe("ai");
    });

    it("with customer AI disabled a new web chat is HUMAN and nothing is answered automatically", async () => {
      await configureWidget(t.adminA, false);
      const token = await session();
      const id = await chat(token);
      expect(await mode(id)).toBe("HUMAN");
      expect(await aiCount(id)).toBe(0);
      expect(enqueued).toHaveLength(0);
      expect(fake.generateCalls).toHaveLength(0);
    });

    it("in-app (staff-created) conversations are HUMAN and AI mode cannot be set on them", async () => {
      const conversation = await seedConversation(t.orgA.id, t.customerA.id);
      expect(await mode(conversation.id)).toBe("HUMAN");
      await expect(
        setHandlingMode(await ctxOf(t.adminA), conversation.id, "AI"),
      ).rejects.toMatchObject({
        status: 409,
      });
    });
  });

  describe("what switches the mode", () => {
    it("the visitor asking for a person switches to HUMAN once, with audit events", async () => {
      const token = await session();
      const id = await chat(token);
      await say(token, id, "I want to talk to a person.");
      expect(await mode(id)).toBe("HUMAN");
      expect((await row(id)).humanRequestedAt).not.toBeNull();
      await widgetCall(handoffPost, { token, method: "POST", params: { conversationId: id } });
      const events = await modeEvents(id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ actorType: "CUSTOMER" });
      expect(events[0].metadata).toMatchObject({
        from: "AI",
        to: "HUMAN",
        reason: "visitor_requested",
      });
      expect((await view(token, id)).conversation.assistant).toBe("human");
    });

    it("an unanswerable question (AI fallback) does NOT change the mode", async () => {
      fake.generation = UNKNOWN;
      const token = await session();
      const id = await chat(token, "can it be done eariler?");
      expect(await aiCount(id)).toBe(1);
      expect(await mode(id)).toBe("AI");
      expect((await row(id)).humanRequestedAt).toBeNull();
      expect(await modeEvents(id)).toHaveLength(0);
    });

    it("an agent claiming or being assigned switches to HUMAN; unassigning does not bring the AI back", async () => {
      const token = await session();
      const id = await chat(token);
      await assignConversation(await ctxOf(t.memberA), id, t.memberA.id); // a member claims it
      expect(await mode(id)).toBe("HUMAN");
      const events = await modeEvents(id);
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({ reason: "assigned" });

      const { unassignConversation } = await import("@/server/services/conversations");
      await unassignConversation(await ctxOf(t.memberA), id);
      expect(await mode(id)).toBe("HUMAN");
      const before = await aiCount(id);
      await say(token, id, REFUND_Q);
      expect(await aiCount(id)).toBe(before);
    });

    it("an agent reply to the visitor takes over; an internal note does not", async () => {
      const token = await session();
      const id = await chat(token);
      await sendMessage(await ctxOf(t.memberA), id, {
        body: "note to self",
        type: "INTERNAL_NOTE",
        from: "USER",
      });
      expect(await mode(id)).toBe("AI");
      await sendMessage(await ctxOf(t.memberA), id, { body: "Hi!", type: "MESSAGE", from: "USER" });
      expect(await mode(id)).toBe("HUMAN");
      expect((await modeEvents(id))[0].metadata).toMatchObject({ reason: "agent_replied" });
    });

    it("a manual switch to HUMAN stops automatic replies and sends nothing by itself", async () => {
      const token = await session();
      const id = await chat(token);
      const messages = await totalMessages(id);
      const updated = await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      expect(updated.handlingMode).toBe("HUMAN");
      expect(await totalMessages(id)).toBe(messages);
      await say(token, id, "How long do refunds take?");
      expect(await aiCount(id)).toBe(1);
    });

    it("switching back to AI allows FUTURE messages only, keeps the history and sends nothing", async () => {
      const token = await session();
      const id = await chat(token);
      await say(token, id, "I want to talk to a person.");
      expect(await mode(id)).toBe("HUMAN");
      const messages = await totalMessages(id);
      const callsBefore = fake.generateCalls.length;

      const updated = await setHandlingMode(await ctxOf(t.adminA), id, "AI");
      await queue.drain();
      expect(updated.handlingMode).toBe("AI");
      expect(updated.humanRequestedAt).toBeNull(); // the request is answered
      expect(await totalMessages(id)).toBe(messages); // no unsolicited message
      expect(fake.generateCalls.length).toBe(callsBefore);
      expect((await modeEvents(id)).map((e) => (e.metadata as { to: string }).to)).toEqual([
        "HUMAN",
        "AI",
      ]);
      const requests = (
        await (await db()).conversationEvent.findMany({ where: { conversationId: id } })
      ).filter((e) => e.type === "HUMAN_REQUESTED");
      expect(requests).toHaveLength(1); // audit history kept

      const before = await aiCount(id);
      await say(token, id, "How long do refunds take?");
      expect(await aiCount(id)).toBe(before + 1);
      // A new request for a person works again after switching back.
      await say(token, id, "Please connect me with support");
      expect(await mode(id)).toBe("HUMAN");
      expect((await modeEvents(id)).length).toBe(3);
    });

    it("switching to the mode it already has is a no-op (no event)", async () => {
      const token = await session();
      const id = await chat(token);
      await setHandlingMode(await ctxOf(t.adminA), id, "AI");
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      expect(await modeEvents(id)).toHaveLength(1);
    });

    it("AI mode is refused when customer AI is disabled for the organization", async () => {
      const token = await session();
      const id = await chat(token);
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      await configureWidget(t.adminA, false);
      await expect(setHandlingMode(await ctxOf(t.adminA), id, "AI")).rejects.toMatchObject({
        status: 409,
      });
      expect(await mode(id)).toBe("HUMAN");
    });
  });

  describe("queued and in-flight AI work obeys the mode", () => {
    async function firstVisitorMessage(id: string) {
      return (await db()).message.findFirstOrThrow({
        where: { conversationId: id, senderType: "CUSTOMER" },
        orderBy: { createdAt: "asc" },
      });
    }
    const job = (orgId: string, conversationId: string, messageId: string) => ({
      kind: "customer-ai" as const,
      executionId: `customer-ai-${messageId}`,
      organizationId: orgId,
      conversationId,
      messageId,
    });
    const attempt = { attempt: 1, maxAttempts: 5 };

    it("a job queued before a manual switch to HUMAN does nothing", async () => {
      await configureWidget(t.adminA, false);
      const token = await session();
      const id = await chat(token); // HUMAN: nothing queued
      await configureWidget(t.adminA, true);
      await setHandlingMode(await ctxOf(t.adminA), id, "AI");
      const message = await firstVisitorMessage(id);
      // The job exists (queued while in AI mode) ...
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      // ... and runs after the switch.
      const calls = fake.generateCalls.length;
      await processCustomerAiJob(job(t.orgA.id, id, message.id), attempt);
      expect(await aiCount(id)).toBe(0);
      expect(fake.generateCalls.length).toBe(calls);
    });

    it("scheduling is refused up front for a HUMAN conversation (nothing is queued)", async () => {
      const token = await session();
      const id = await chat(token);
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      enqueued.length = 0;
      await say(token, id, "How long do refunds take?");
      expect(enqueued).toHaveLength(0);
    });

    it("a mode change while the model is generating discards the late answer", async () => {
      const token = await session();
      const id = await chat(token);
      expect(await aiCount(id)).toBe(1);
      fake.delayMs = 400;
      const calls = fake.generateCalls.length;
      await widgetCall(messagePost, {
        token,
        method: "POST",
        params: { conversationId: id },
        body: { body: "How long do refunds take?", clientMessageId: uuid() },
      });
      for (let i = 0; i < 100 && fake.generateCalls.length === calls; i += 1) await tick(20);
      expect(fake.generateCalls.length).toBeGreaterThan(calls); // generation started
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      await queue.drain();
      expect(await aiCount(id)).toBe(1);
    });

    it("the reply is stored atomically: after the switch committed, persisting an AI reply is refused", async () => {
      const token = await session();
      const id = await chat(token);
      await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
      const before = await totalMessages(id);
      await expect(
        persistMessage({
          organizationId: t.orgA.id,
          actor: { kind: "ai" },
          conversationId: id,
          input: { body: "late answer", type: "MESSAGE", from: "USER" },
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await totalMessages(id)).toBe(before);
    });

    it("the claim holds the row: a concurrent switch waits for the reply, and a switch that won makes the claim fail", async () => {
      const token = await session();
      const id = await chat(token);

      // (a) The AI transaction claims first; the agent's switch must wait until it commits.
      let switched = false;
      let agentSwitch: Promise<void> | undefined;
      await transaction(async (tx) => {
        expect(await conversationsRepository.claimForAiReply(t.orgA.id, id, tx)).toBe(true);
        agentSwitch = setHandlingMode(await ctxOf(t.adminA), id, "HUMAN").then(() => {
          switched = true;
        });
        await tick(300);
        expect(switched).toBe(false); // blocked on the row lock held by this transaction
      });
      await agentSwitch; // the transaction committed: the switch can proceed now
      expect(switched).toBe(true);
      expect(await mode(id)).toBe("HUMAN");

      // (b) The switch committed first: the claim matches nothing.
      expect(await conversationsRepository.claimForAiReply(t.orgA.id, id)).toBe(false);
    });

    it("racing many switches against AI replies never leaves a reply after the takeover", async () => {
      for (let round = 0; round < 6; round += 1) {
        const token = await session();
        const id = await chat(token, `Round ${round}: what is the refund policy?`);
        const message = await firstVisitorMessage(id);
        // Remove the first reply so the race is about a fresh one.
        await (
          await db()
        ).message.deleteMany({ where: { conversationId: id, senderType: "AI_AGENT" } });
        await Promise.all([
          processCustomerAiJob(job(t.orgA.id, id, message.id), attempt),
          setHandlingMode(await ctxOf(t.adminA), id, "HUMAN"),
        ]);
        expect(await mode(id)).toBe("HUMAN");
        // Whatever the order, nothing can be added by the AI after the switch.
        const count = await aiCount(id);
        await processCustomerAiJob(job(t.orgA.id, id, message.id), attempt);
        expect(await aiCount(id)).toBe(count);
        expect(count).toBeLessThanOrEqual(1);
      }
    });

    it("duplicate and concurrent jobs still produce a single reply", async () => {
      const token = await session();
      const id = await chat(token);
      const message = await firstVisitorMessage(id);
      await Promise.all([
        processCustomerAiJob(job(t.orgA.id, id, message.id), attempt),
        processCustomerAiJob(job(t.orgA.id, id, message.id), attempt),
        processCustomerAiJob(job(t.orgA.id, id, message.id), attempt),
      ]);
      expect(await aiCount(id)).toBe(1);
    });
  });

  describe("resolved and reopened conversations", () => {
    it("no AI reply is generated while resolved", async () => {
      const token = await session();
      const id = await chat(token);
      const message = await (
        await db()
      ).message.findFirstOrThrow({
        where: { conversationId: id, senderType: "CUSTOMER" },
      });
      await (
        await db()
      ).message.deleteMany({ where: { conversationId: id, senderType: "AI_AGENT" } });
      await updateConversation(await ctxOf(t.memberA), id, { status: "RESOLVED" });
      const calls = fake.generateCalls.length;
      await processCustomerAiJob(
        {
          kind: "customer-ai",
          executionId: `customer-ai-${message.id}`,
          organizationId: t.orgA.id,
          conversationId: id,
          messageId: message.id,
        },
        { attempt: 1, maxAttempts: 5 },
      );
      expect(await aiCount(id)).toBe(0);
      expect(fake.generateCalls.length).toBe(calls);
    });

    it("a visitor message reopens a resolved AI-mode conversation and the AI answers", async () => {
      const token = await session();
      const id = await chat(token);
      await updateConversation(await ctxOf(t.memberA), id, { status: "RESOLVED" });
      expect(await mode(id)).toBe("AI");
      await say(token, id, "Actually, how long do refunds take?");
      const after = await row(id);
      expect(after.status).toBe("OPEN");
      expect(after.handlingMode).toBe("AI"); // reopening never changes the mode
      expect(await aiCount(id)).toBe(2);
    });

    it("a resolved conversation taken over by a person stays HUMAN when the visitor writes again", async () => {
      const token = await session();
      const id = await chat(token);
      await assignConversation(await ctxOf(t.memberA), id, t.memberA.id);
      await updateConversation(await ctxOf(t.memberA), id, { status: "RESOLVED" });
      await say(token, id, "One more question: how long do refunds take?");
      const after = await row(id);
      expect(after.status).toBe("OPEN");
      expect(after.handlingMode).toBe("HUMAN");
      expect(await aiCount(id)).toBe(1); // only the first, pre-takeover answer
    });
  });

  describe("authorization and tenant isolation (API)", () => {
    const post = (id: string, mode: string) =>
      call(handlingRoute, { method: "POST", params: { conversationId: id }, body: { mode } });

    it("only ADMIN/OWNER may change the mode; members get 403, anonymous 401", async () => {
      const token = await session();
      const id = await chat(token);
      as(t.memberA);
      expect((await post(id, "HUMAN")).status).toBe(403);
      expect(await mode(id)).toBe("AI");
      signOut();
      expect((await post(id, "HUMAN")).status).toBe(401);
      as(t.adminA);
      const ok = await post(id, "HUMAN");
      expect(ok.status).toBe(200);
      expect(ok.body.conversation.handlingMode).toBe("HUMAN");
      as(t.ownerA);
      expect((await post(id, "AI")).status).toBe(200);
    });

    it("validates the body (strict) and the id", async () => {
      const token = await session();
      const id = await chat(token);
      as(t.adminA);
      expect((await post(id, "ROBOT")).status).toBe(400);
      const extra = await call(handlingRoute, {
        method: "POST",
        params: { conversationId: id },
        body: { mode: "HUMAN", organizationId: t.orgB.id },
      });
      expect(extra.status).toBe(400);
      expect((await post("not-a-uuid", "HUMAN")).status).toBe(404);
    });

    it("another organization cannot read or change it (404)", async () => {
      const token = await session();
      const id = await chat(token);
      as(t.ownerB);
      expect((await post(id, "HUMAN")).status).toBe(404);
      expect(await mode(id)).toBe("AI");
    });
  });

  describe("the internal Ask AI draft workflow is unchanged", () => {
    it("drafts work in both modes, store nothing and never touch the mode", async () => {
      const token = await session();
      const id = await chat(token);
      for (const target of ["AI", "HUMAN"] as const) {
        await (await db()).conversation.update({ where: { id }, data: { handlingMode: target } });
        const before = await totalMessages(id);
        as(t.memberA);
        const draft = await call(aiDraftRoute, { method: "POST", params: { conversationId: id } });
        expect(draft.status).toBe(200);
        expect(draft.body.draft).toBeTruthy();
        expect(await totalMessages(id)).toBe(before);
        expect(await mode(id)).toBe(target);
      }
    });
  });
});
