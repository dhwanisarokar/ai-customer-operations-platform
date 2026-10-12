import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as handoffRoute } from "@/app/api/portal/[org]/conversations/[conversationId]/handoff/route";
import { POST as messageRoute } from "@/app/api/portal/[org]/conversations/[conversationId]/messages/route";
import { GET as conversationRoute } from "@/app/api/portal/[org]/conversations/[conversationId]/route";
import {
  GET as conversationsRoute,
  POST as createRoute,
} from "@/app/api/portal/[org]/conversations/route";
import { GET as eventsRoute } from "@/app/api/portal/[org]/events/route";
import { GET as articleRoute } from "@/app/api/portal/[org]/help/[articleId]/route";
import { GET as helpRoute } from "@/app/api/portal/[org]/help/route";
import { POST as joinRoute } from "@/app/api/portal/[org]/join/route";
import { GET as meRoute } from "@/app/api/portal/[org]/me/route";
import { GET as profileGet, PATCH as profilePatch } from "@/app/api/portal/[org]/profile/route";
import { GET as summaryRoute } from "@/app/api/portal/[org]/summary/route";
import {
  DELETE as accessDelete,
  GET as accessGet,
} from "@/app/api/customers/[customerId]/portal-access/route";
import { POST as inviteRoute } from "@/app/api/customers/[customerId]/portal-invite/route";
import { GET as settingsGet, PUT as settingsPut } from "@/app/api/portal-settings/route";
import { GET as staffConversationsRoute } from "@/app/api/conversations/route";
import { GET as staffCustomersRoute } from "@/app/api/customers/route";
import { automationInputSchema } from "@/server/automation/definition";
import { setAutomationQueueForTesting } from "@/server/automation/queue";
import { MemoryAutomationQueue } from "@/server/automation/queue/memory";
import { requireOrganizationContext } from "@/server/auth/context";
import { MemoryRateLimiter, setRateLimiterForTesting } from "@/server/rate-limit";
import { portalChannel } from "@/server/realtime/channels";
import type { RealtimeEvent } from "@/server/realtime/events";
import { subscribeRealtime } from "@/server/realtime/publisher";
import { archiveCustomer } from "@/server/services/customers";
import { createAutomation } from "@/server/services/automations";
import { sendMessage } from "@/server/services/conversation-messages";
import { updateConversation } from "@/server/services/conversations";
import { setHandlingMode } from "@/server/services/conversation-handling";
import { createPortalInvite } from "@/server/portal/admin";
import { updateWidgetSettings, getWidgetSettings } from "@/server/widget/settings";
import { installFakeAi, uninstallFakeAi, type FakeAiProvider } from "../helpers/ai";
import { call } from "../helpers/api";
import { seedConversation, seedMessage } from "../helpers/conversations";
import { createTestUser, describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { REFUND_DOC, createPublishedDocument, setupAiTenants } from "../helpers/knowledge";
import { session, signOut } from "../helpers/mocks";
import { as, seedCustomer } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

const uuid = () => crypto.randomUUID();
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

type TestUser = Awaited<ReturnType<typeof createTestUser>>;

describeDb(
  "customer portal: identity linking, tenant isolation, conversations, help and profile",
  () => {
    let t: Awaited<ReturnType<typeof setupAiTenants>>;
    let carol: Awaited<ReturnType<typeof seedCustomer>>;
    let alicePortal: TestUser; // Alice's verified identity
    let carolPortal: TestUser;
    let queue: MemoryAutomationQueue;
    let fake: FakeAiProvider;
    let slugA: string;
    let slugB: string;

    const db = async () => (await import("@/db/client")).getDb();
    const ctxOf = async (user: { authProviderId: string }) => {
      as(user);
      return requireOrganizationContext();
    };
    const org = (slug = slugA) => ({ org: slug });
    const withParams = (extra: Record<string, string>, slug = slugA) => ({ org: slug, ...extra });

    function identify(user: TestUser, email: string, verified = true) {
      session.profiles.set(user.authProviderId, {
        email,
        emailVerified: verified,
        name: user.name,
      });
    }

    async function enablePortal(user: { authProviderId: string }) {
      as(user);
      const r = await call(settingsPut, { method: "PUT", body: { enabled: true } });
      expect(r.status).toBe(200);
    }

    /** The full, legitimate linking flow: staff invite, then the signed-in customer redeems it. */
    async function link(user: TestUser, customerId: string, slug = slugA, staff = t.adminA) {
      const ctx = await ctxOf(staff);
      const invite = await createPortalInvite(ctx, customerId);
      as(user);
      const r = await call(joinRoute, {
        method: "POST",
        params: org(slug),
        body: { token: invite.token },
      });
      expect(r.status).toBe(200);
    }

    const mine = (user: TestUser) => {
      as(user);
    };

    async function startConversation(
      user: TestUser,
      body = "My invoice is wrong",
      subject = "Invoice problem",
    ) {
      mine(user);
      const r = await call(createRoute, {
        method: "POST",
        params: org(),
        body: { subject, body, clientMessageId: uuid() },
      });
      expect(r.status).toBe(201);
      await queue.drain();
      return r.body.conversation.id as string;
    }

    beforeEach(async () => {
      await resetDatabase();
      t = await setupAiTenants();
      carol = await seedCustomer(t.orgA.id, { firstName: "Carol", email: "carol@a.test" });
      alicePortal = await createTestUser("portalalice");
      carolPortal = await createTestUser("portalcarol");
      identify(alicePortal, "alice.private@a.test");
      identify(carolPortal, "carol@a.test");
      setRateLimiterForTesting(new MemoryRateLimiter());
      queue = new MemoryAutomationQueue({ backoffBaseMs: 0 });
      setAutomationQueueForTesting(queue);
      fake = installFakeAi();
      slugA = t.orgA.slug;
      slugB = t.orgB.slug;
      await enablePortal(t.adminA);
      await link(alicePortal, t.customerA.id);
      await link(carolPortal, carol.id);
    });
    afterEach(() => {
      uninstallFakeAi();
      setRateLimiterForTesting(undefined);
      setAutomationQueueForTesting(undefined);
    });
    afterAll(disconnectDatabase);

    describe("authentication and the unlinked identity", () => {
      it("signed-out requests are 401 on every protected portal route", async () => {
        signOut();
        const id = uuid();
        for (const [handler, params] of [
          [summaryRoute, org()],
          [conversationsRoute, org()],
          [conversationRoute, withParams({ conversationId: id })],
          [profileGet, org()],
          [helpRoute, org()],
          [articleRoute, withParams({ articleId: id })],
          [meRoute, org()],
          [eventsRoute, org()],
        ] as const) {
          expect((await call(handler, { params })).status).toBe(401);
        }
        expect((await call(createRoute, { method: "POST", params: org(), body: {} })).status).toBe(
          401,
        );
      });

      it("an authenticated but UNLINKED identity gets 403 portal_not_linked and no customer data", async () => {
        const stranger = await createTestUser("stranger");
        identify(stranger, "stranger@example.com");
        as(stranger);
        for (const [handler, params] of [
          [summaryRoute, org()],
          [conversationsRoute, org()],
          [profileGet, org()],
          [helpRoute, org()],
        ] as const) {
          const r = await call(handler, { params });
          expect(r.status).toBe(403);
          expect(r.body.error.code).toBe("portal_not_linked");
        }
        const me = await call(meRoute, { params: org() });
        expect(me.status).toBe(200);
        expect(me.body).toMatchObject({ linked: false });
        expect(JSON.stringify(me.body)).not.toMatch(/alice|carol|customer/i);
      });

      it("a linked customer reaches their own portal", async () => {
        mine(alicePortal);
        const summary = await call(summaryRoute, { params: org() });
        expect(summary.status).toBe(200);
        expect(summary.body).toMatchObject({ organization: { slug: slugA }, total: 0, open: 0 });
        const me = await call(meRoute, { params: org() });
        expect(me.body).toMatchObject({ linked: true, customer: { firstName: "Alice" } });
      });

      it("an unknown or disabled portal is a plain 404 (same for everyone)", async () => {
        mine(alicePortal);
        expect((await call(summaryRoute, { params: org("no-such-org") })).status).toBe(404);
        // Organization B exists but never enabled its portal.
        const disabled = await call(summaryRoute, { params: org(slugB) });
        const unknown = await call(summaryRoute, { params: org("no-such-org") });
        expect(disabled.status).toBe(404);
        expect(disabled.body.error.message).toBe(unknown.body.error.message);
      });
    });

    describe("account linking", () => {
      it("an email match alone grants nothing: no invitation, no link", async () => {
        const twin = await createTestUser("twin");
        identify(twin, "carol@a.test"); // verified, same email as Carol, but never invited
        as(twin);
        expect((await call(summaryRoute, { params: org() })).status).toBe(403);
        expect((await call(joinRoute, { method: "POST", params: org(), body: {} })).status).toBe(
          400,
        );
        const bogus = await call(joinRoute, {
          method: "POST",
          params: org(),
          body: { token: "pi_" + "x".repeat(40) },
        });
        expect(bogus.status).toBe(404);
        expect(await (await db()).customerPortalAccount.count({ where: { userId: twin.id } })).toBe(
          0,
        );
      });

      it("an invitation needs the identity's VERIFIED email to equal the customer's email", async () => {
        const dave = await seedCustomer(t.orgA.id, { firstName: "Dave", email: "dave@a.test" });
        const invite = await createPortalInvite(await ctxOf(t.adminA), dave.id);
        const forwarded = await createTestUser("forwarded");
        const join = () =>
          call(joinRoute, { method: "POST", params: org(), body: { token: invite.token } });

        identify(forwarded, "someone-else@example.com");
        as(forwarded);
        const mismatch = await join();
        expect(mismatch.status).toBe(403);
        expect(mismatch.body.error.code).toBe("invite_email_mismatch");

        identify(forwarded, "dave@a.test", false); // right address, NOT verified
        expect((await join()).status).toBe(403);

        identify(forwarded, "DAVE@a.test", true); // verified (case-insensitive)
        expect((await join()).status).toBe(200);
        expect((await join()).body).toMatchObject({ alreadyLinked: true }); // idempotent
      });

      it("an invitation is single use and expires; it is bound to one organization", async () => {
        const dave = await seedCustomer(t.orgA.id, { firstName: "Dave", email: "dave@a.test" });
        const invite = await createPortalInvite(await ctxOf(t.adminA), dave.id);
        const first = await createTestUser("first");
        const second = await createTestUser("second");
        identify(first, "dave@a.test");
        identify(second, "dave@a.test");
        as(first);
        expect(
          (await call(joinRoute, { method: "POST", params: org(), body: { token: invite.token } }))
            .status,
        ).toBe(200);
        as(second);
        expect(
          (await call(joinRoute, { method: "POST", params: org(), body: { token: invite.token } }))
            .status,
        ).toBe(404);

        // Expired.
        const erin = await seedCustomer(t.orgA.id, { firstName: "Erin", email: "erin@a.test" });
        const old = await createPortalInvite(await ctxOf(t.adminA), erin.id);
        await (
          await db()
        ).portalInvite.updateMany({
          where: { customerId: erin.id },
          data: {
            createdAt: new Date(Date.now() - 10_000),
            expiresAt: new Date(Date.now() - 1000),
          },
        });
        const erinUser = await createTestUser("erinuser");
        identify(erinUser, "erin@a.test");
        as(erinUser);
        expect(
          (await call(joinRoute, { method: "POST", params: org(), body: { token: old.token } }))
            .status,
        ).toBe(404);

        // Another organization's portal cannot redeem it.
        await enablePortal(t.ownerB);
        const crossUser = await createTestUser("crossuser");
        identify(crossUser, "dave@a.test");
        as(crossUser);
        const frank = await seedCustomer(t.orgA.id, { firstName: "Frank", email: "frank@a.test" });
        const inviteA = await createPortalInvite(await ctxOf(t.adminA), frank.id);
        as(crossUser);
        expect(
          (
            await call(joinRoute, {
              method: "POST",
              params: org(slugB),
              body: { token: inviteA.token },
            })
          ).status,
        ).toBe(404);
      });

      it("concurrent redemptions of one invitation create exactly one link", async () => {
        const dave = await seedCustomer(t.orgA.id, { firstName: "Dave", email: "dave@a.test" });
        const invite = await createPortalInvite(await ctxOf(t.adminA), dave.id);
        const users = await Promise.all([
          createTestUser("r1"),
          createTestUser("r2"),
          createTestUser("r3"),
        ]);
        for (const u of users) identify(u, "dave@a.test");
        const results = await Promise.all(
          users.map(async (u) => {
            as(u); // the identity mock is process wide: set right before each call starts
            return call(joinRoute, {
              method: "POST",
              params: org(),
              body: { token: invite.token },
            });
          }),
        );
        const ok = results.filter((r) => r.status === 200);
        expect(ok.length).toBeGreaterThanOrEqual(1);
        // Whatever the interleaving, the database holds ONE account for Dave.
        expect(
          await (await db()).customerPortalAccount.count({ where: { customerId: dave.id } }),
        ).toBe(1);
      });

      it("conflicts are rejected: one customer per identity, one identity per customer", async () => {
        // Alice's identity is linked; staff cannot invite the already linked customer again.
        const again = await call(inviteRoute, {
          method: "POST",
          params: { customerId: t.customerA.id },
        });
        as(t.adminA);
        const second = await call(inviteRoute, {
          method: "POST",
          params: { customerId: t.customerA.id },
        });
        expect(second.status).toBe(409);
        void again;

        // The identity (now claiming Carol's address) cannot link a SECOND customer in the same organization.
        const erin = await seedCustomer(t.orgA.id, { firstName: "Erin", email: "erin@a.test" });
        const inviteErin = await createPortalInvite(await ctxOf(t.adminA), erin.id);
        identify(alicePortal, "erin@a.test");
        as(alicePortal);
        const conflict = await call(joinRoute, {
          method: "POST",
          params: org(),
          body: { token: inviteErin.token },
        });
        expect(conflict.status).toBe(409);
        expect(
          await (await db()).customerPortalAccount.count({ where: { userId: alicePortal.id } }),
        ).toBe(1);

        // The database itself refuses duplicates even if application code were bypassed.
        await expect(
          (await db()).customerPortalAccount.create({
            data: { organizationId: t.orgA.id, customerId: t.customerA.id, userId: carolPortal.id },
          }),
        ).rejects.toThrow();
      });

      it("a customer record of another organization cannot be linked (composite foreign key)", async () => {
        await expect(
          (await db()).customerPortalAccount.create({
            data: { organizationId: t.orgA.id, customerId: t.customerB.id, userId: alicePortal.id },
          }),
        ).rejects.toThrow();
      });

      it("archived customers cannot be invited and lose access", async () => {
        await archiveCustomer(await ctxOf(t.adminA), t.customerA.id);
        mine(alicePortal);
        expect((await call(summaryRoute, { params: org() })).status).toBe(403);
        as(t.adminA);
        const erin = await seedCustomer(t.orgA.id, {
          firstName: "Erin",
          email: "erin@a.test",
          status: "ARCHIVED",
        });
        const r = await call(inviteRoute, { method: "POST", params: { customerId: erin.id } });
        expect(r.status).toBe(409);
      });

      it("a customer without an email cannot be invited", async () => {
        const noEmail = await seedCustomer(t.orgA.id, { firstName: "NoMail" });
        as(t.adminA);
        expect(
          (await call(inviteRoute, { method: "POST", params: { customerId: noEmail.id } })).status,
        ).toBe(409);
      });

      it("staff identity does not imply customer-record ownership", async () => {
        // A staff member whose email equals a customer's email, who is NOT linked, has no portal access.
        identify(t.memberA, "alice.private@a.test");
        as(t.memberA);
        expect((await call(summaryRoute, { params: org() })).status).toBe(403);
        // ... while still being a perfectly normal staff member.
        expect((await call(staffCustomersRoute, {})).status).toBe(200);
      });

      it("a portal identity is not staff: internal APIs stay closed to it", async () => {
        mine(alicePortal);
        const customers = await call(staffCustomersRoute, {});
        const conversations = await call(staffConversationsRoute, {});
        expect([403, 404]).toContain(customers.status);
        expect([403, 404]).toContain(conversations.status);
        expect(JSON.stringify([customers.body, conversations.body])).not.toContain("Alice");
        const admin = await call(settingsGet, {});
        expect([403, 404]).toContain(admin.status);
      });

      it("revoking access removes it immediately and cancels pending invitations", async () => {
        as(t.adminA);
        expect(
          (await call(accessGet, { params: { customerId: t.customerA.id } })).body.access,
        ).toMatchObject({ linked: true });
        const revoked = await call(accessDelete, {
          method: "DELETE",
          params: { customerId: t.customerA.id },
        });
        expect(revoked.body).toEqual({ removed: true });
        mine(alicePortal);
        expect((await call(summaryRoute, { params: org() })).status).toBe(403);
        // The customer can be invited again afterwards.
        as(t.adminA);
        expect(
          (await call(inviteRoute, { method: "POST", params: { customerId: t.customerA.id } }))
            .status,
        ).toBe(201);
      });

      it("portal administration needs manage_portal and respects tenants", async () => {
        as(t.memberA);
        expect((await call(settingsPut, { method: "PUT", body: { enabled: false } })).status).toBe(
          403,
        );
        expect(
          (await call(inviteRoute, { method: "POST", params: { customerId: carol.id } })).status,
        ).toBe(403);
        expect((await call(accessGet, { params: { customerId: carol.id } })).status).toBe(403);
        signOut();
        expect((await call(settingsGet, {})).status).toBe(401);
        as(t.ownerB);
        expect(
          (await call(inviteRoute, { method: "POST", params: { customerId: carol.id } })).status,
        ).toBe(404);
        expect(
          (
            await call(settingsPut, {
              method: "PUT",
              body: { organizationId: t.orgA.id, enabled: true },
            })
          ).status,
        ).toBe(400);
        as(t.adminA);
        const invite = await call(inviteRoute, {
          method: "POST",
          params: {
            customerId: (await seedCustomer(t.orgA.id, { firstName: "G", email: "g@a.test" })).id,
          },
        });
        expect(invite.status).toBe(201);
        expect(invite.body.invite.joinPath).toMatch(
          new RegExp(`^/portal/${slugA}/join\\?token=pi_`),
        );
        // Only the hash is stored.
        const stored = await (await db()).portalInvite.findMany();
        expect(JSON.stringify(stored)).not.toContain(
          invite.body.invite.joinPath.split("token=")[1],
        );
      });
    });

    describe("conversations", () => {
      it("starting a conversation stores a CUSTOMER message of the linked customer (channel PORTAL)", async () => {
        const id = await startConversation(alicePortal);
        const row = await (await db()).conversation.findUniqueOrThrow({ where: { id } });
        expect(row).toMatchObject({
          organizationId: t.orgA.id,
          customerId: t.customerA.id,
          channel: "PORTAL",
          visitorSessionId: null,
          status: "OPEN",
        });
        const messages = await (await db()).message.findMany({ where: { conversationId: id } });
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
          senderType: "CUSTOMER",
          senderUserId: null,
          messageType: "MESSAGE",
        });
        const events = await (
          await db()
        ).conversationEvent.findMany({ where: { conversationId: id } });
        expect(
          events.every((e) => e.actorType === "CUSTOMER" && e.actorId === t.customerA.id),
        ).toBe(true);
      });

      it("creation is idempotent per clientMessageId", async () => {
        mine(alicePortal);
        const clientMessageId = uuid();
        const body = { subject: "Hello", body: "Hi there", clientMessageId };
        const first = await call(createRoute, { method: "POST", params: org(), body });
        const second = await call(createRoute, { method: "POST", params: org(), body });
        expect([first.status, second.status]).toEqual([201, 200]);
        expect(second.body.conversation.id).toBe(first.body.conversation.id);
        expect(await (await db()).conversation.count({ where: { channel: "PORTAL" } })).toBe(1);
      });

      it("a customer sees only their own conversations; another customer's id is a plain 404", async () => {
        const aliceConv = await startConversation(
          alicePortal,
          "Alice private matter",
          "Alice topic",
        );
        const carolConv = await startConversation(
          carolPortal,
          "Carol private matter",
          "Carol topic",
        );

        mine(alicePortal);
        const list = await call(conversationsRoute, { params: org() });
        expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([aliceConv]);
        expect(JSON.stringify(list.body)).not.toContain("Carol");

        const peek = await call(conversationRoute, {
          params: withParams({ conversationId: carolConv }),
        });
        const ghost = await call(conversationRoute, {
          params: withParams({ conversationId: uuid() }),
        });
        expect(peek.status).toBe(404);
        expect(peek.body.error.message).toBe(ghost.body.error.message);
        expect(JSON.stringify(peek.body)).not.toContain("Carol");

        for (const handler of [messageRoute, handoffRoute] as const) {
          const r = await call(handler, {
            method: "POST",
            params: withParams({ conversationId: carolConv }),
            body: { body: "hijack", clientMessageId: uuid() },
          });
          expect(r.status).toBe(404);
        }
        expect(await (await db()).message.count({ where: { conversationId: carolConv } })).toBe(1);
      });

      it("other channels of the same customer (staff-created, web chat) and other tenants are not exposed", async () => {
        const internal = await seedConversation(t.orgA.id, t.customerA.id, {
          subject: "Internal escalation",
        });
        await seedMessage(t.orgA.id, internal.id, { body: "internal text", senderType: "USER" });
        const otherTenant = await seedConversation(t.orgB.id, t.customerB.id);
        mine(alicePortal);
        expect((await call(conversationsRoute, { params: org() })).body.items).toEqual([]);
        expect(
          (await call(conversationRoute, { params: withParams({ conversationId: internal.id }) }))
            .status,
        ).toBe(404);
        expect(
          (
            await call(conversationRoute, {
              params: withParams({ conversationId: otherTenant.id }),
            })
          ).status,
        ).toBe(404);
      });

      it("rejects spoofed customer, organization, sender, status and mode fields", async () => {
        const id = await startConversation(alicePortal);
        mine(alicePortal);
        for (const extra of [
          { customerId: t.customerB.id },
          { organizationId: t.orgB.id },
          { senderType: "USER" },
          { senderUserId: t.ownerA.id },
          { from: "USER" },
          { type: "INTERNAL_NOTE" },
          { status: "RESOLVED" },
          { priority: "URGENT" },
          { handlingMode: "AI" },
          { assignedToUserId: t.ownerA.id },
          { actorType: "USER" },
        ]) {
          setRateLimiterForTesting(new MemoryRateLimiter()); // each probe gets a fresh budget
          const send = await call(messageRoute, {
            method: "POST",
            params: withParams({ conversationId: id }),
            body: { body: "x", clientMessageId: uuid(), ...extra },
          });
          expect(send.status).toBe(400);
          const create = await call(createRoute, {
            method: "POST",
            params: org(),
            body: { subject: "s", body: "x", clientMessageId: uuid(), ...extra },
          });
          expect(create.status).toBe(400);
        }
        expect(await (await db()).message.count({ where: { conversationId: id } })).toBe(1);
        const conversation = await (await db()).conversation.findUniqueOrThrow({ where: { id } });
        expect(conversation).toMatchObject({
          status: "OPEN",
          priority: "NORMAL",
          assignedToUserId: null,
        });
      });

      it("validates sizes: empty, too long, huge payload", async () => {
        const id = await startConversation(alicePortal);
        mine(alicePortal);
        const send = (body: unknown, rawBody?: string) =>
          call(messageRoute, {
            method: "POST",
            params: withParams({ conversationId: id }),
            body,
            rawBody,
          });
        expect((await send({ body: "  ", clientMessageId: uuid() })).status).toBe(400);
        expect((await send({ body: "a".repeat(4001), clientMessageId: uuid() })).status).toBe(400);
        expect((await send(undefined, "{bad json")).status).toBe(400);
        expect((await send(undefined, JSON.stringify({ body: "a".repeat(40_000) }))).status).toBe(
          413,
        );
        const page = await call(conversationsRoute, { params: org(), query: { pageSize: "500" } });
        expect(page.status).toBe(400);
      });

      it("shows customer messages, AI replies and human replies; never notes or internal metadata", async () => {
        const id = await startConversation(alicePortal);
        await seedMessage(t.orgA.id, id, {
          body: "AI says hello",
          senderType: "AI_AGENT",
          metadata: {
            provider: "gemini",
            model: "secret-model",
            sources: [{ documentId: "d1", chunkId: "c1" }],
            handoffSuggested: false,
          },
        } as never);
        const ctx = await ctxOf(t.memberA);
        await sendMessage(ctx, id, {
          body: "INTERNAL-NOTE-SECRET",
          type: "INTERNAL_NOTE",
          from: "USER",
        });
        await sendMessage(ctx, id, { body: "Hi, Sam from support", type: "MESSAGE", from: "USER" });

        mine(alicePortal);
        const detail = await call(conversationRoute, {
          params: withParams({ conversationId: id }),
        });
        expect(detail.status).toBe(200);
        expect(detail.body.messages.map((m: { from: string }) => m.from)).toEqual([
          "visitor",
          "ai",
          "team",
        ]);
        const text = JSON.stringify(detail.body);
        expect(text).not.toMatch(
          /INTERNAL-NOTE-SECRET|secret-model|provider|chunkId|documentId|metadata|assignedTo|membera@/i,
        );
        expect(detail.body.messages[2]).toMatchObject({ authorName: expect.any(String) });
        expect(Object.keys(detail.body.messages[0]).sort()).toEqual(
          [
            "authorName",
            "body",
            "clientMessageId",
            "createdAt",
            "from",
            "handoffSuggested",
            "id",
          ].sort(),
        );
      });

      it("message retries never duplicate (sequential and concurrent)", async () => {
        const id = await startConversation(alicePortal);
        mine(alicePortal);
        const clientMessageId = uuid();
        const send = () =>
          call(messageRoute, {
            method: "POST",
            params: withParams({ conversationId: id }),
            body: { body: "More details", clientMessageId },
          });
        const first = await send();
        const second = await send();
        const [a, b] = await Promise.all([send(), send()]);
        expect([first.status, second.status]).toEqual([201, 200]);
        expect(a.body.message.id).toBe(first.body.message.id);
        expect(b.body.message.id).toBe(first.body.message.id);
        await queue.drain();
        expect(
          await (
            await db()
          ).message.count({ where: { conversationId: id, senderType: "CUSTOMER" } }),
        ).toBe(2);
      });

      it("a customer message on a resolved conversation reopens it (existing status policy)", async () => {
        const id = await startConversation(alicePortal);
        await updateConversation(await ctxOf(t.memberA), id, { status: "RESOLVED" });
        mine(alicePortal);
        const r = await call(messageRoute, {
          method: "POST",
          params: withParams({ conversationId: id }),
          body: { body: "Actually one more thing", clientMessageId: uuid() },
        });
        expect(r.status).toBe(201);
        await queue.drain();
        expect((await (await db()).conversation.findUniqueOrThrow({ where: { id } })).status).toBe(
          "OPEN",
        );
        const events = await (
          await db()
        ).conversationEvent.findMany({ where: { conversationId: id, type: "STATUS_CHANGED" } });
        expect(
          events.some((e) => (e.metadata as { reason?: string }).reason === "customer_message"),
        ).toBe(true);
      });

      it("a customer cannot resolve, assign or change anything beyond messaging (no such routes)", async () => {
        const id = await startConversation(alicePortal);
        mine(alicePortal);
        // The customer's session on the STAFF conversation APIs is refused.
        const { PATCH: staffPatch } =
          await import("@/app/api/conversations/[conversationId]/route");
        const r = await call(staffPatch, {
          method: "PATCH",
          params: { conversationId: id },
          body: { status: "RESOLVED" },
        });
        expect([403, 404]).toContain(r.status);
        expect((await (await db()).conversation.findUniqueOrThrow({ where: { id } })).status).toBe(
          "OPEN",
        );
      });

      it("pagination and the home summary", async () => {
        for (let i = 0; i < 3; i += 1)
          await startConversation(alicePortal, `Message ${i}`, `Topic ${i}`);
        mine(alicePortal);
        const p1 = await call(conversationsRoute, {
          params: org(),
          query: { page: "1", pageSize: "2" },
        });
        const p2 = await call(conversationsRoute, {
          params: org(),
          query: { page: "2", pageSize: "2" },
        });
        expect(p1.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
        expect(p1.body.items).toHaveLength(2);
        expect(p2.body.items).toHaveLength(1);
        const summary = await call(summaryRoute, { params: org() });
        expect(summary.body).toMatchObject({ total: 3, open: 3 });
        expect(summary.body.recent).toHaveLength(3);
      });
    });

    describe("AI, handling mode and handoff in the portal", () => {
      async function enableCustomerAi() {
        const ctx = await ctxOf(t.adminA);
        await getWidgetSettings(ctx);
        await updateWidgetSettings(ctx, {
          enabled: true,
          displayName: "Support",
          welcomeMessage: "Hi",
          accentColor: null,
          allowedOrigins: [],
          aiRepliesEnabled: true,
        });
        await createPublishedDocument(ctx, REFUND_DOC);
        fake.generateCalls.length = 0;
      }
      const aiCount = async (id: string) =>
        (await db()).message.count({ where: { conversationId: id, senderType: "AI_AGENT" } });

      it("without customer AI the conversation is HUMAN and nothing is answered automatically", async () => {
        const id = await startConversation(alicePortal, "What is your refund policy?");
        expect(
          (await (await db()).conversation.findUniqueOrThrow({ where: { id } })).handlingMode,
        ).toBe("HUMAN");
        expect(await aiCount(id)).toBe(0);
        expect(fake.generateCalls).toHaveLength(0);
      });

      it("with customer AI on, a portal conversation starts in AI mode and is answered asynchronously from published knowledge", async () => {
        await enableCustomerAi();
        mine(alicePortal);
        const created = await call(createRoute, {
          method: "POST",
          params: org(),
          body: {
            subject: "Refunds",
            body: "What is your refund policy?",
            clientMessageId: uuid(),
          },
        });
        expect(created.status).toBe(201);
        const id = created.body.conversation.id as string;
        expect(created.body.conversation.assistant).toBe("ai");
        await queue.drain();
        expect(await aiCount(id)).toBe(1);
        mine(alicePortal);
        const detail = await call(conversationRoute, {
          params: withParams({ conversationId: id }),
        });
        expect(detail.body.messages.map((m: { from: string }) => m.from)).toEqual([
          "visitor",
          "ai",
        ]);
        expect(detail.body.messages[1].body).toContain("30 days");
        expect(fake.lastPrompt()).not.toMatch(/alice|anders|acme/i); // no customer record reaches the model
      });

      it("an agent switching to HUMAN stops the AI in the portal conversation; back to AI resumes", async () => {
        await enableCustomerAi();
        const id = await startConversation(alicePortal, "What is your refund policy?");
        expect(await aiCount(id)).toBe(1);
        await setHandlingMode(await ctxOf(t.adminA), id, "HUMAN");
        mine(alicePortal);
        await call(messageRoute, {
          method: "POST",
          params: withParams({ conversationId: id }),
          body: { body: "How long do refunds take?", clientMessageId: uuid() },
        });
        await queue.drain();
        expect(await aiCount(id)).toBe(1);
        await setHandlingMode(await ctxOf(t.adminA), id, "AI");
        mine(alicePortal);
        await call(messageRoute, {
          method: "POST",
          params: withParams({ conversationId: id }),
          body: { body: "How long do refunds take?", clientMessageId: uuid() },
        });
        await queue.drain();
        expect(await aiCount(id)).toBe(2);
      });

      it("'Talk to a person' hands the portal conversation to people (marker, HUMAN mode, events)", async () => {
        await enableCustomerAi();
        const id = await startConversation(alicePortal, "What is your refund policy?");
        mine(alicePortal);
        const r = await call(handoffRoute, {
          method: "POST",
          params: withParams({ conversationId: id }),
        });
        expect(r.status).toBe(200);
        const row = await (await db()).conversation.findUniqueOrThrow({ where: { id } });
        expect(row.humanRequestedAt).not.toBeNull();
        expect(row.handlingMode).toBe("HUMAN");
        const events = await (
          await db()
        ).conversationEvent.findMany({ where: { conversationId: id } });
        const requested = events.filter((e) => e.type === "HUMAN_REQUESTED");
        expect(requested).toHaveLength(1);
        expect(requested[0]).toMatchObject({ actorType: "CUSTOMER", actorId: t.customerA.id });
        await call(handoffRoute, { method: "POST", params: withParams({ conversationId: id }) });
        expect(
          (
            await (
              await db()
            ).conversationEvent.findMany({ where: { conversationId: id, type: "HUMAN_REQUESTED" } })
          ).length,
        ).toBe(1);
        // The AI stays silent afterwards.
        await call(messageRoute, {
          method: "POST",
          params: withParams({ conversationId: id }),
          body: { body: "Hello?", clientMessageId: uuid() },
        });
        await queue.drain();
        expect(await aiCount(id)).toBe(1);
      });

      it("the internal Ask AI draft workflow works for portal conversations and stores nothing", async () => {
        await enableCustomerAi();
        const id = await startConversation(alicePortal, "What is your refund policy?");
        const { POST: draftRoute } =
          await import("@/app/api/conversations/[conversationId]/ai-draft/route");
        as(t.memberA);
        const before = await (await db()).message.count({ where: { conversationId: id } });
        const draft = await call(draftRoute, { method: "POST", params: { conversationId: id } });
        expect(draft.status).toBe(200);
        expect(await (await db()).message.count({ where: { conversationId: id } })).toBe(before);
      });
    });

    describe("realtime and automation use the existing events", () => {
      it("a team reply reaches the customer's own portal channel only, never a note, never another customer", async () => {
        const id = await startConversation(alicePortal);
        const mineEvents: RealtimeEvent[] = [];
        const carolEvents: RealtimeEvent[] = [];
        const offA = subscribeRealtime(portalChannel(t.orgA.id, t.customerA.id), (e) =>
          mineEvents.push(e),
        );
        const offC = subscribeRealtime(portalChannel(t.orgA.id, carol.id), (e) =>
          carolEvents.push(e),
        );
        const ctx = await ctxOf(t.memberA);
        await sendMessage(ctx, id, { body: "internal", type: "INTERNAL_NOTE", from: "USER" });
        await tick(100);
        expect(mineEvents.filter((e) => e.type === "message.created")).toHaveLength(0);
        await sendMessage(ctx, id, { body: "Hello from the team", type: "MESSAGE", from: "USER" });
        await tick(150);
        offA();
        offC();
        expect(
          mineEvents.some((e) => e.type === "message.created" && e.conversationId === id),
        ).toBe(true);
        expect(carolEvents).toHaveLength(0);
        expect(JSON.stringify(mineEvents)).not.toMatch(/Hello from the team|internal/);
      });

      it("the events route only serves the signed-in customer's channel", async () => {
        signOut();
        expect((await call(eventsRoute, { params: org() })).status).toBe(401);
        const stranger = await createTestUser("stranger2");
        identify(stranger, "s@example.com");
        as(stranger);
        expect((await call(eventsRoute, { params: org() })).status).toBe(403);
        mine(alicePortal);
        const controller = new AbortController();
        const response = await (
          eventsRoute as unknown as (
            r: Request,
            c: { params: Promise<unknown> },
          ) => Promise<Response>
        )(new Request("http://localhost/api/portal/x/events", { signal: controller.signal }), {
          params: Promise.resolve(org()),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain("text/event-stream");
        controller.abort();
        await response.body?.cancel().catch(() => undefined);
      });

      it("a portal message triggers message.created automations (customer-authored) like any other", async () => {
        const automation = await createAutomation(
          await ctxOf(t.adminA),
          automationInputSchema.parse({
            name: "on customer message",
            trigger: "message.created",
            conditions: [{ field: "senderType", operator: "equals", value: "CUSTOMER" }],
            actions: [{ type: "create_customer_note", input: { content: "fired" } }],
          }),
        );
        const id = await startConversation(alicePortal);
        mine(alicePortal);
        await call(messageRoute, {
          method: "POST",
          params: withParams({ conversationId: id }),
          body: { body: "second message", clientMessageId: uuid() },
        });
        await queue.drain();
        const runs = await (
          await db()
        ).automationExecution.findMany({ where: { automationId: automation.id } });
        expect(runs.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe("help center", () => {
      it("lists and opens PUBLISHED articles of this organization only", async () => {
        const ctxA = await ctxOf(t.adminA);
        await createPublishedDocument(ctxA, REFUND_DOC);
        const { createDocument, archiveDocument } = await import("@/server/services/knowledge");
        await createDocument(ctxA, {
          title: "Secret draft",
          description: null,
          content: "DRAFT-ONLY content",
        });
        const archived = await createPublishedDocument(ctxA, {
          title: "Old policy",
          content: "ARCHIVED-ONLY content",
        });
        await archiveDocument(ctxA, archived.id);
        const ctxB = await ctxOf(t.ownerB);
        await createPublishedDocument(ctxB, {
          title: "Bravo article",
          content: "BRAVO-ONLY content",
        });

        mine(alicePortal);
        const list = await call(helpRoute, { params: org() });
        expect(list.status).toBe(200);
        expect(list.body.items.map((a: { title: string }) => a.title)).toEqual(["Refund policy"]);
        const text = JSON.stringify(list.body);
        expect(text).not.toMatch(
          /DRAFT-ONLY|ARCHIVED-ONLY|BRAVO-ONLY|Secret draft|Old policy|Bravo/,
        );
        expect(Object.keys(list.body.items[0]).sort()).toEqual([
          "id",
          "publishedAt",
          "summary",
          "title",
        ]);

        const search = await call(helpRoute, { params: org(), query: { q: "refund" } });
        expect(search.body.items).toHaveLength(1);
        expect(
          (await call(helpRoute, { params: org(), query: { q: "zzz-nothing" } })).body.items,
        ).toEqual([]);
        expect(
          (await call(helpRoute, { params: org(), query: { q: "ARCHIVED-ONLY" } })).body.items,
        ).toEqual([]);

        const article = await call(articleRoute, {
          params: withParams({ articleId: list.body.items[0].id }),
        });
        expect(article.status).toBe(200);
        expect(Object.keys(article.body.article).sort()).toEqual([
          "content",
          "id",
          "publishedAt",
          "summary",
          "title",
        ]);
        const drafts = await (
          await db()
        ).knowledgeDocument.findMany({ where: { status: { in: ["DRAFT", "ARCHIVED"] } } });
        for (const doc of drafts) {
          expect(
            (await call(articleRoute, { params: withParams({ articleId: doc.id }) })).status,
          ).toBe(404);
        }
        const bravo = await (
          await db()
        ).knowledgeDocument.findFirstOrThrow({ where: { organizationId: t.orgB.id } });
        expect(
          (await call(articleRoute, { params: withParams({ articleId: bravo.id }) })).status,
        ).toBe(404);
      });
    });

    describe("profile", () => {
      it("shows the permitted fields only", async () => {
        mine(alicePortal);
        const r = await call(profileGet, { params: org() });
        expect(r.body.profile).toEqual({
          firstName: "Alice",
          lastName: "Anders",
          email: "alice.private@a.test",
          phone: "+15550100",
          company: "Acme",
        });
      });

      it("allows name and phone changes, recorded on the customer's timeline", async () => {
        mine(alicePortal);
        const r = await call(profilePatch, {
          method: "PATCH",
          params: org(),
          body: { firstName: "Alicia", lastName: "Andersen", phone: "+1 (555) 010-9999" },
        });
        expect(r.status).toBe(200);
        expect(r.body.profile).toMatchObject({
          firstName: "Alicia",
          lastName: "Andersen",
          phone: "+15550109999",
        });
        const row = await (
          await db()
        ).customer.findUniqueOrThrow({ where: { id: t.customerA.id } });
        expect(row).toMatchObject({ firstName: "Alicia", email: "alice.private@a.test" });
        const activity = await (
          await db()
        ).customerActivity.findFirst({
          where: { customerId: t.customerA.id, type: "CUSTOMER_UPDATED" },
          orderBy: { createdAt: "desc" },
        });
        expect(activity).toMatchObject({ actorType: "CUSTOMER", actorId: t.customerA.id });
      });

      it("rejects every other field: email takeover, company, status, tags, ids", async () => {
        mine(alicePortal);
        for (const body of [
          { email: "carol@a.test" },
          { email: "attacker@evil.test" },
          { company: "Evil" },
          { status: "ARCHIVED" },
          { customerId: carol.id },
          { organizationId: t.orgB.id },
          { externalId: "x" },
          { tags: ["vip"] },
          {},
        ]) {
          const r = await call(profilePatch, { method: "PATCH", params: org(), body });
          expect(r.status).toBe(400);
        }
        const row = await (
          await db()
        ).customer.findUniqueOrThrow({ where: { id: t.customerA.id } });
        expect(row).toMatchObject({ email: "alice.private@a.test", company: "Acme" });
        const carolRow = await (await db()).customer.findUniqueOrThrow({ where: { id: carol.id } });
        expect(carolRow.email).toBe("carol@a.test");
        // Carol can still sign in as Carol.
        mine(carolPortal);
        expect((await call(profileGet, { params: org() })).body.profile.firstName).toBe("Carol");
      });

      it("validates values", async () => {
        mine(alicePortal);
        expect(
          (await call(profilePatch, { method: "PATCH", params: org(), body: { firstName: "" } }))
            .status,
        ).toBe(400);
        expect(
          (
            await call(profilePatch, {
              method: "PATCH",
              params: org(),
              body: { phone: "not a phone" },
            })
          ).status,
        ).toBe(400);
        const cleared = await call(profilePatch, {
          method: "PATCH",
          params: org(),
          body: { phone: null, lastName: "" },
        });
        expect(cleared.body.profile).toMatchObject({ phone: null, lastName: null });
      });
    });

    describe("rate limiting", () => {
      it("limits messages per customer with Retry-After semantics (429)", async () => {
        const id = await startConversation(alicePortal);
        mine(alicePortal);
        let last = { status: 0 };
        for (let i = 0; i < 31; i += 1) {
          last = await call(messageRoute, {
            method: "POST",
            params: withParams({ conversationId: id }),
            body: { body: `m${i}`, clientMessageId: uuid() },
          });
        }
        expect(last.status).toBe(429);
        // Another customer is not affected.
        const carolConv = await startConversation(carolPortal, "hi", "Carol topic");
        mine(carolPortal);
        expect(
          (
            await call(messageRoute, {
              method: "POST",
              params: withParams({ conversationId: carolConv }),
              body: { body: "ok", clientMessageId: uuid() },
            })
          ).status,
        ).toBe(201);
      });
    });
  },
);
