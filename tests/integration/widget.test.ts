import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GET as conversationsGet,
  POST as conversationsPost,
} from "@/app/api/widget/conversations/route";
import { GET as conversationGet } from "@/app/api/widget/conversations/[conversationId]/route";
import { POST as messagePost } from "@/app/api/widget/conversations/[conversationId]/messages/route";
import { POST as handoffPost } from "@/app/api/widget/conversations/[conversationId]/handoff/route";
import { POST as identityPost } from "@/app/api/widget/identity/route";
import { GET as eventsGet } from "@/app/api/widget/events/route";
import { POST as sessionPost } from "@/app/api/widget/session/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/widget-settings/route";
import { GET as inboxEventsGet } from "@/app/api/realtime/inbox/route";
import { automationInputSchema } from "@/server/automation/definition";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { requireOrganizationContext } from "@/server/auth/context";
import { inboxChannel, visitorChannel } from "@/server/realtime/channels";
import { subscribeRealtime } from "@/server/realtime/publisher";
import type { RealtimeEvent } from "@/server/realtime/events";
import { MemoryRateLimiter, setRateLimiterForTesting } from "@/server/rate-limit";
import { sendMessage } from "@/server/services/conversation-messages";
import { assignConversation, updateConversation } from "@/server/services/conversations";
import { createAutomation } from "@/server/services/automations";
import { updateWidgetSettings } from "@/server/widget/settings";
import { getWidgetSettings } from "@/server/widget/settings";
import { conversationRow, eventsOf, setupConversationTenants } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { signOut } from "../helpers/mocks";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type Tenants = Awaited<ReturnType<typeof setupConversationTenants>>;
type Handler = (request: Request, context: { params: Promise<never> }) => Promise<Response>;

async function widgetCall(
  handler: unknown,
  options: {
    token?: string | null;
    method?: string;
    body?: unknown;
    rawBody?: string;
    params?: Record<string, string>;
    ip?: string;
  } = {},
) {
  const { token, method = "GET", body, rawBody, params = {}, ip = "1.1.1.1" } = options;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-forwarded-for": ip,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const request = new Request("http://localhost/api/widget/test", {
    method,
    headers,
    body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const response = await (handler as Handler)(request, {
    params: Promise.resolve(params) as Promise<never>,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text ? JSON.parse(text) : null,
  };
}

const uuid = () => crypto.randomUUID();
const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

describeDb("web chat widget: sessions, visitors, handoff, realtime and security", () => {
  let t: Tenants;
  let keyA: string;
  let keyB: string;
  let queue: MemoryAutomationQueue;

  const ctxOf = async (user: { authProviderId: string }) => {
    as(user);
    return requireOrganizationContext();
  };
  const db = async () => (await import("@/db/client")).getDb();

  async function enable(
    user: { authProviderId: string },
    patch: Partial<{ enabled: boolean; allowedOrigins: string[] }> = {},
  ) {
    const ctx = await ctxOf(user);
    const current = await getWidgetSettings(ctx);
    await updateWidgetSettings(ctx, {
      enabled: true,
      displayName: "Support",
      welcomeMessage: "Hi! How can we help?",
      accentColor: null,
      allowedOrigins: [],
      ...patch,
    });
    return current.publicKey;
  }

  async function startSession(key: string, ip = "1.1.1.1") {
    const result = await widgetCall(sessionPost, {
      method: "POST",
      body: { key },
      ip,
    });
    expect(result.status).toBe(200);
    return { token: result.body.token as string, sessionId: result.body.session.id as string };
  }

  async function startChat(token: string, body = "Hello, I need help") {
    const result = await widgetCall(conversationsPost, {
      token,
      method: "POST",
      body: { body, clientMessageId: uuid() },
    });
    expect(result.status).toBe(201);
    return result.body.conversation.id as string;
  }

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
    setRateLimiterForTesting(new MemoryRateLimiter());
    queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
    setAutomationQueueForTesting(queue);
    keyA = await enable(t.adminA);
    keyB = await enable(t.ownerB);
  });
  afterEach(() => {
    setRateLimiterForTesting(undefined);
    setAutomationQueueForTesting(undefined);
  });
  afterAll(disconnectDatabase);

  describe("widget settings and public config", () => {
    it("settings are created disabled with a fresh key, and only admins manage them", async () => {
      const fresh = await resetAndSetup();
      const settings = await getWidgetSettings(await ctxOf(fresh.adminA));
      expect(settings.enabled).toBe(false);
      expect(settings.publicKey).toMatch(/^wk_/);
      await expect(getWidgetSettings(await ctxOf(fresh.memberA))).rejects.toMatchObject({
        status: 403,
      });
    });

    it("the settings API validates input and rejects an organizationId", async () => {
      as(t.adminA);
      const ok = await widgetCall(settingsGet);
      expect(ok.status).toBe(200);
      const bad = await widgetCall(settingsPut, {
        method: "PUT",
        body: {
          enabled: true,
          displayName: "X",
          welcomeMessage: "Hi",
          allowedOrigins: [],
          organizationId: t.orgB.id,
        },
      });
      expect(bad.status).toBe(400);
      const invalidOrigin = await widgetCall(settingsPut, {
        method: "PUT",
        body: {
          enabled: true,
          displayName: "X",
          welcomeMessage: "Hi",
          allowedOrigins: ["not a url"],
        },
      });
      expect(invalidOrigin.status).toBe(400);
      as(t.memberA);
      expect((await widgetCall(settingsGet)).status).toBe(403);
      signOut();
      expect((await widgetCall(settingsGet)).status).toBe(401);
    });

    it("an invalid or disabled key cannot open a session", async () => {
      const invalid = await widgetCall(sessionPost, {
        method: "POST",
        body: { key: "wk_doesnotexistdoesnotexist" },
      });
      expect(invalid.status).toBe(404);
      await updateWidgetSettings(await ctxOf(t.adminA), {
        enabled: false,
        displayName: "Support",
        welcomeMessage: "Hi",
        accentColor: null,
        allowedOrigins: [],
      });
      const disabled = await widgetCall(sessionPost, { method: "POST", body: { key: keyA } });
      expect(disabled.status).toBe(404);
    });

    it("the session response never contains an organization id", async () => {
      const result = await widgetCall(sessionPost, { method: "POST", body: { key: keyA } });
      expect(JSON.stringify(result.body)).not.toContain(t.orgA.id);
      expect(result.body.widget).toMatchObject({ displayName: "Support" });
    });

    it("enforces the embedding-origin allowlist when one is configured", async () => {
      await enable(t.adminA, { allowedOrigins: ["https://shop.example.com"] });
      const blocked = await widgetCall(sessionPost, {
        method: "POST",
        body: { key: keyA, embedOrigin: "https://evil.example.org" },
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.error.code).toBe("origin_not_allowed");
      const missing = await widgetCall(sessionPost, { method: "POST", body: { key: keyA } });
      expect(missing.status).toBe(403);
      const allowed = await widgetCall(sessionPost, {
        method: "POST",
        body: { key: keyA, embedOrigin: "https://shop.example.com/page?x=1" },
      });
      expect(allowed.status).toBe(200);
    });
  });

  describe("visitor sessions", () => {
    it("starts a session, stores only a token hash and can resume it", async () => {
      const { token, sessionId } = await startSession(keyA);
      const row = await (await db()).visitorSession.findUniqueOrThrow({ where: { id: sessionId } });
      expect(row.organizationId).toBe(t.orgA.id);
      expect(row.tokenHash).not.toContain(token);
      expect(row.customerId).toBeNull();
      const resumed = await widgetCall(sessionPost, { method: "POST", body: { key: keyA }, token });
      expect(resumed.status).toBe(200);
      expect(resumed.body.token).toBeNull();
      expect(resumed.body.session.id).toBe(sessionId);
    });

    it("a token from another organization's widget is not reused", async () => {
      const a = await startSession(keyA);
      const resumed = await widgetCall(sessionPost, {
        method: "POST",
        body: { key: keyB },
        token: a.token,
      });
      expect(resumed.status).toBe(200);
      expect(resumed.body.session.id).not.toBe(a.sessionId);
      expect(resumed.body.token).toMatch(/^vs_/);
    });

    it("requests without, with a bad, expired or revoked token are 401", async () => {
      expect((await widgetCall(conversationsGet)).status).toBe(401);
      expect((await widgetCall(conversationsGet, { token: "vs_nonsense" })).status).toBe(401);
      const { token, sessionId } = await startSession(keyA);
      expect((await widgetCall(conversationsGet, { token })).status).toBe(200);
      await (
        await db()
      ).visitorSession.update({
        where: { id: sessionId },
        data: {
          createdAt: new Date(Date.now() - 20_000),
          expiresAt: new Date(Date.now() - 1000),
        },
      });
      expect((await widgetCall(conversationsGet, { token })).status).toBe(401);
      const second = await startSession(keyA);
      await (
        await db()
      ).visitorSession.update({
        where: { id: second.sessionId },
        data: { revokedAt: new Date() },
      });
      expect((await widgetCall(conversationsGet, { token: second.token })).status).toBe(401);
    });

    it("an existing session stops working when the organization disables the widget", async () => {
      const { token } = await startSession(keyA);
      await enable(t.adminA, { enabled: false });
      expect((await widgetCall(conversationsGet, { token })).status).toBe(403);
    });
  });

  describe("conversations and messages", () => {
    it("creates a WEB_CHAT conversation with a customer message and a placeholder customer", async () => {
      const { token, sessionId } = await startSession(keyA);
      const id = await startChat(token);
      const row = await conversationRow(id);
      expect(row).toMatchObject({
        organizationId: t.orgA.id,
        channel: "WEB_CHAT",
        visitorSessionId: sessionId,
        status: "OPEN",
        humanRequestedAt: null,
      });
      const messages = await (await db()).message.findMany({ where: { conversationId: id } });
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ senderType: "CUSTOMER", senderUserId: null });
      const customer = await (
        await db()
      ).customer.findUniqueOrThrow({
        where: { id: row.customerId },
      });
      expect(customer).toMatchObject({ organizationId: t.orgA.id, source: "web_chat" });
      const session = await (
        await db()
      ).visitorSession.findUniqueOrThrow({
        where: { id: sessionId },
      });
      expect(session.customerId).toBe(customer.id);
      const events = await eventsOf(id);
      expect(events.some((e) => e.actorType === "CUSTOMER")).toBe(true);
    });

    it("conversation creation is idempotent by clientMessageId", async () => {
      const { token } = await startSession(keyA);
      const clientMessageId = uuid();
      const first = await widgetCall(conversationsPost, {
        token,
        method: "POST",
        body: { body: "Hi", clientMessageId },
      });
      const second = await widgetCall(conversationsPost, {
        token,
        method: "POST",
        body: { body: "Hi", clientMessageId },
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(second.body.conversation.id).toBe(first.body.conversation.id);
      expect(await (await db()).conversation.count()).toBe(1);
      expect(await (await db()).message.count()).toBe(1);
    });

    it("sends messages as the visitor and retries never duplicate", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      const clientMessageId = uuid();
      const send = () =>
        widgetCall(messagePost, {
          token,
          method: "POST",
          params: { conversationId: id },
          body: { body: "More details", clientMessageId },
        });
      const first = await send();
      const second = await send();
      const [a, b] = await Promise.all([send(), send()]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(200);
      expect(a.body.message.id).toBe(first.body.message.id);
      expect(b.body.message.id).toBe(first.body.message.id);
      const messages = await (await db()).message.findMany({ where: { conversationId: id } });
      expect(messages).toHaveLength(2);
    });

    it("a visitor cannot choose the sender, organization, customer or conversation owner", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      for (const extra of [
        { senderType: "USER" },
        { from: "USER" },
        { organizationId: t.orgB.id },
        { customerId: t.customerB.id },
        { senderUserId: t.ownerA.id },
        { type: "INTERNAL_NOTE" },
      ]) {
        const result = await widgetCall(messagePost, {
          token,
          method: "POST",
          params: { conversationId: id },
          body: { body: "x", clientMessageId: uuid(), ...extra },
        });
        expect(result.status).toBe(400);
      }
      const rows = await (await db()).message.findMany({ where: { conversationId: id } });
      expect(rows.every((m) => m.senderType === "CUSTOMER")).toBe(true);
    });

    it("validates body length, emptiness and size", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      const call = (body: unknown, rawBody?: string) =>
        widgetCall(messagePost, {
          token,
          method: "POST",
          params: { conversationId: id },
          body,
          rawBody,
        });
      expect((await call({ body: "   ", clientMessageId: uuid() })).status).toBe(400);
      expect((await call({ body: "a".repeat(2001), clientMessageId: uuid() })).status).toBe(400);
      expect((await call({ body: "hi", clientMessageId: "nope" })).status).toBe(400);
      expect((await call(undefined, "{not json")).status).toBe(400);
      const huge = await call(undefined, JSON.stringify({ body: "a".repeat(20_000) }));
      expect(huge.status).toBe(413);
    });

    it("another visitor in the same organization cannot read or write my conversation", async () => {
      const mine = await startSession(keyA);
      const other = await startSession(keyA, "2.2.2.2");
      const id = await startChat(mine.token);
      const read = await widgetCall(conversationGet, {
        token: other.token,
        params: { conversationId: id },
      });
      expect(read.status).toBe(404);
      const write = await widgetCall(messagePost, {
        token: other.token,
        method: "POST",
        params: { conversationId: id },
        body: { body: "hijack", clientMessageId: uuid() },
      });
      expect(write.status).toBe(404);
      const handoff = await widgetCall(handoffPost, {
        token: other.token,
        method: "POST",
        params: { conversationId: id },
      });
      expect(handoff.status).toBe(404);
      const list = await widgetCall(conversationsGet, { token: other.token });
      expect(list.body.conversations).toEqual([]);
      expect(await (await db()).message.count({ where: { conversationId: id } })).toBe(1);
    });

    it("a visitor of another organization cannot reach the conversation either", async () => {
      const mine = await startSession(keyA);
      const foreign = await startSession(keyB, "3.3.3.3");
      const id = await startChat(mine.token);
      const read = await widgetCall(conversationGet, {
        token: foreign.token,
        params: { conversationId: id },
      });
      expect(read.status).toBe(404);
      expect(read.body.error.code).toBe("not_found");
      const malformed = await widgetCall(conversationGet, {
        token: mine.token,
        params: { conversationId: "not-a-uuid" },
      });
      expect(malformed.status).toBe(404);
    });

    it("staff messages reach the visitor but internal notes and metadata never do", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      const ctx = await ctxOf(t.memberA);
      await sendMessage(ctx, id, {
        body: "SECRET internal note",
        type: "INTERNAL_NOTE",
        from: "USER",
      });
      await sendMessage(ctx, id, { body: "Happy to help!", type: "MESSAGE", from: "USER" });
      const result = await widgetCall(conversationGet, {
        token,
        params: { conversationId: id },
      });
      expect(result.status).toBe(200);
      const text = JSON.stringify(result.body);
      expect(text).not.toContain("SECRET");
      expect(text).not.toContain("alice@");
      expect(text).not.toContain(t.memberA.id);
      expect(text).not.toContain(t.orgA.id);
      expect(text).not.toMatch(/draft|provenance|toolCall|assignedTo|internal/i);
      const bodies = result.body.messages.map((m: { body: string }) => m.body);
      expect(bodies).toEqual(["Hello, I need help", "Happy to help!"]);
      const reply = result.body.messages[1];
      expect(reply.from).toBe("team");
    });

    it("limits the number of conversations per session", async () => {
      setRateLimiterForTesting(new MemoryRateLimiter());
      const { token } = await startSession(keyA);
      for (let i = 0; i < 10; i += 1) {
        await (
          await import("@/server/widget/visitor")
        ).createVisitorConversation(
          await (await import("@/server/widget/session")).authenticateVisitor(token),
          { body: `chat ${i}`, clientMessageId: uuid() },
        );
      }
      const over = await widgetCall(conversationsPost, {
        token,
        method: "POST",
        body: { body: "one more", clientMessageId: uuid() },
      });
      expect(over.status).toBe(409);
    });
  });

  describe("identity", () => {
    it("links the visitor to an existing customer by normalized email, with no duplicates", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      const placeholderId = (await conversationRow(id)).customerId;
      const before = await (await db()).customer.count({ where: { organizationId: t.orgA.id } });
      const result = await widgetCall(identityPost, {
        token,
        method: "POST",
        body: { email: "  ALICE@a.test ", name: "Mallory" },
      });
      expect(result.status).toBe(200);
      const row = await conversationRow(id);
      expect(row.customerId).toBe(t.customerA.id);
      const alice = await (
        await db()
      ).customer.findUniqueOrThrow({ where: { id: t.customerA.id } });
      expect(alice.firstName).toBe("Alice"); // an existing customer is never edited by a visitor
      const placeholder = await (
        await db()
      ).customer.findUniqueOrThrow({
        where: { id: placeholderId },
      });
      expect(placeholder.status).toBe("ARCHIVED");
      const after = await (
        await db()
      ).customer.count({
        where: { organizationId: t.orgA.id, status: { not: "ARCHIVED" } },
      });
      expect(after).toBe(before - 1 + 0); // the placeholder was archived, no new active customer
    });

    it("the same email from two visitors resolves to one customer", async () => {
      const one = await startSession(keyA);
      const two = await startSession(keyA, "4.4.4.4");
      const a = await startChat(one.token);
      const b = await startChat(two.token);
      for (const token of [one.token, two.token]) {
        const r = await widgetCall(identityPost, {
          token,
          method: "POST",
          body: { email: "newperson@example.com", name: "New Person" },
        });
        expect(r.status).toBe(200);
      }
      const customers = await (
        await db()
      ).customer.findMany({
        where: { organizationId: t.orgA.id, email: "newperson@example.com" },
      });
      expect(customers).toHaveLength(1);
      expect((await conversationRow(a)).customerId).toBe(customers[0].id);
      expect((await conversationRow(b)).customerId).toBe(customers[0].id);
    });

    it("never links to a customer of another organization", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      await widgetCall(identityPost, {
        token,
        method: "POST",
        body: { email: "bob@b.test" },
      });
      const row = await conversationRow(id);
      expect(row.customerId).not.toBe(t.customerB.id);
      const customer = await (
        await db()
      ).customer.findUniqueOrThrow({
        where: { id: row.customerId },
      });
      expect(customer.organizationId).toBe(t.orgA.id);
    });

    it("rejects client-supplied customer ids and invalid emails", async () => {
      const { token } = await startSession(keyA);
      await startChat(token);
      const withId = await widgetCall(identityPost, {
        token,
        method: "POST",
        body: { email: "x@example.com", customerId: t.customerA.id },
      });
      expect(withId.status).toBe(400);
      const bad = await widgetCall(identityPost, {
        token,
        method: "POST",
        body: { email: "not-an-email" },
      });
      expect(bad.status).toBe(400);
      const empty = await widgetCall(identityPost, { token, method: "POST", body: {} });
      expect(empty.status).toBe(400);
    });
  });

  describe("human handoff", () => {
    it("marks the conversation, records an event once, and assigning clears the marker", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      const first = await widgetCall(handoffPost, {
        token,
        method: "POST",
        params: { conversationId: id },
      });
      const second = await widgetCall(handoffPost, {
        token,
        method: "POST",
        params: { conversationId: id },
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const row = await conversationRow(id);
      expect(row.humanRequestedAt).not.toBeNull();
      expect((await eventsOf(id)).filter((e) => e.type === "HUMAN_REQUESTED")).toHaveLength(1);
      // The inbox sees it and filters to WEB_CHAT.
      await assignConversation(await ctxOf(t.adminA), id, t.memberA.id);
      const claimed = await conversationRow(id);
      expect(claimed.assignedToUserId).toBe(t.memberA.id);
      expect(claimed.humanRequestedAt).toBeNull();
    });

    it("sends no automatic AI reply and creates no AI draft", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      await widgetCall(handoffPost, { token, method: "POST", params: { conversationId: id } });
      const messages = await (await db()).message.findMany({ where: { conversationId: id } });
      expect(messages.every((m) => m.senderType === "CUSTOMER")).toBe(true);
    });
  });

  describe("agent <-> visitor round trip", () => {
    it("an agent reply through the normal path appears in the visitor's conversation", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      await sendMessage(await ctxOf(t.memberA), id, {
        body: "We are on it.",
        type: "MESSAGE",
        from: "USER",
      });
      const result = await widgetCall(conversationGet, {
        token,
        params: { conversationId: id },
      });
      const last = result.body.messages.at(-1);
      expect(last).toMatchObject({ from: "team", body: "We are on it." });
    });
  });

  describe("automation integration", () => {
    it("a visitor message triggers message.created automations (customer-authored), no loops", async () => {
      const automation = await createAutomation(
        await ctxOf(t.adminA),
        automationInputSchema.parse({
          name: "on visitor message",
          trigger: "message.created",
          conditions: [{ field: "senderType", operator: "equals", value: "CUSTOMER" }],
          actions: [{ type: "create_customer_note", input: { content: "fired" } }],
        }),
      );
      const { token } = await startSession(keyA);
      const id = await startChat(token, "Hello");
      await widgetCall(messagePost, {
        token,
        method: "POST",
        params: { conversationId: id },
        body: { body: "I want a refund", clientMessageId: uuid() },
      });
      await queue.drain();
      const runs = await (
        await db()
      ).automationExecution.findMany({
        where: { automationId: automation.id },
      });
      expect(runs.length).toBeGreaterThanOrEqual(1);
      expect(runs.every((r) => r.eventType === "message.created")).toBe(true);
      expect(JSON.stringify(runs)).not.toContain("refund");
      const notes = await (await db()).customerNote.count({ where: { content: "fired" } });
      expect(notes).toBe(runs.filter((r) => r.status === "COMPLETED").length);
      expect(id).toBeTruthy();
    });
  });

  describe("rate limiting", () => {
    it("limits messages per session with a retry-after header", async () => {
      const { token } = await startSession(keyA);
      const id = await startChat(token);
      let last: Awaited<ReturnType<typeof widgetCall>> | undefined;
      for (let i = 0; i < 31; i += 1) {
        last = await widgetCall(messagePost, {
          token,
          method: "POST",
          params: { conversationId: id },
          body: { body: `m${i}`, clientMessageId: uuid() },
        });
      }
      expect(last?.status).toBe(429);
      expect(last?.body.error.code).toBe("rate_limited");
      expect(last?.headers.get("retry-after")).toBeTruthy();
    });

    it("limits session creation per IP but not for another IP", async () => {
      let status = 200;
      for (let i = 0; i < 21; i += 1) {
        status = (
          await widgetCall(sessionPost, { method: "POST", body: { key: keyA }, ip: "9.9.9.9" })
        ).status;
      }
      expect(status).toBe(429);
      const elsewhere = await widgetCall(sessionPost, {
        method: "POST",
        body: { key: keyA },
        ip: "8.8.8.8",
      });
      expect(elsewhere.status).toBe(200);
    });
  });

  describe("realtime routing and authorization", () => {
    async function collect(channel: string) {
      const events: RealtimeEvent[] = [];
      const off = subscribeRealtime(channel, (event) => events.push(event));
      return { events, off };
    }

    it("routes a visitor's events only to that visitor and the org's inbox", async () => {
      const a = await startSession(keyA);
      const b = await startSession(keyA, "5.5.5.5");
      const inboxA = await collect(inboxChannel(t.orgA.id));
      const inboxB = await collect(inboxChannel(t.orgB.id));
      const visitorA = await collect(visitorChannel(a.sessionId));
      const visitorB = await collect(visitorChannel(b.sessionId));
      const id = await startChat(a.token);
      await tick();
      await sendMessage(await ctxOf(t.memberA), id, {
        body: "Hello from the team",
        type: "MESSAGE",
        from: "USER",
      });
      await sendMessage(await ctxOf(t.memberA), id, {
        body: "internal only",
        type: "INTERNAL_NOTE",
        from: "USER",
      });
      await updateConversation(await ctxOf(t.memberA), id, { status: "PENDING" });
      await tick(150);

      expect(inboxA.events.some((e) => e.type === "message.created")).toBe(true);
      expect(inboxB.events).toHaveLength(0);
      expect(visitorB.events).toHaveLength(0);
      const visitorTypes = visitorA.events.map((e) => e.type);
      expect(visitorTypes).toContain("message.created");
      expect(visitorTypes).toContain("conversation.status_changed");
      // The note produced an inbox hint only.
      const noteHints = (events: RealtimeEvent[]) =>
        events.filter((e) => e.type === "message.created").length;
      expect(noteHints(inboxA.events)).toBeGreaterThan(noteHints(visitorA.events));
      expect(JSON.stringify(visitorA.events)).not.toMatch(/internal only|Hello from the team/);
      for (const c of [inboxA, inboxB, visitorA, visitorB]) c.off();
    });

    it("handoff publishes a conversation.updated hint to the inbox", async () => {
      const a = await startSession(keyA);
      const id = await startChat(a.token);
      const inboxA = await collect(inboxChannel(t.orgA.id));
      await widgetCall(handoffPost, {
        token: a.token,
        method: "POST",
        params: { conversationId: id },
      });
      await tick();
      expect(inboxA.events.some((e) => e.type === "conversation.updated")).toBe(true);
      inboxA.off();
    });

    it("the SSE routes authenticate and derive channels from the caller", async () => {
      expect((await widgetCall(eventsGet)).status).toBe(401);
      signOut();
      const anon = await widgetCall(inboxEventsGet);
      expect(anon.status).toBe(401);
      const { token } = await startSession(keyA);
      const controller = new AbortController();
      const request = new Request("http://localhost/api/widget/events", {
        headers: { authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
      const response = await (eventsGet as unknown as Handler)(request, {
        params: Promise.resolve({}) as Promise<never>,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      controller.abort();
      await response.body?.cancel().catch(() => undefined);

      as(t.memberA);
      const agentController = new AbortController();
      const agent = await (inboxEventsGet as unknown as Handler)(
        new Request("http://localhost/api/realtime/inbox", { signal: agentController.signal }),
        { params: Promise.resolve({}) as Promise<never> },
      );
      expect(agent.status).toBe(200);
      agentController.abort();
      await agent.body?.cancel().catch(() => undefined);
    });
  });

  async function resetAndSetup() {
    await resetDatabase();
    t = await setupConversationTenants();
    return t;
  }
});
