import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EVENTS_PARAMS } from "@/features/conversations/api/types";
import { ConversationList } from "@/features/conversations/components/conversation-list";
import { ConversationPane } from "@/features/conversations/components/conversation-pane";
import { CustomerConversations } from "@/features/conversations/components/customer-conversations";
import { parseInboxParams } from "@/features/conversations/inbox-params";
import { QueryProvider } from "@/lib/query/query-provider";
import { serialize } from "@/lib/query/serialize";
import { requireOrganizationContext } from "@/server/auth/context";
import { NotFoundError } from "@/server/errors";
import {
  listConversationEvents,
  listMessages,
  sendMessage,
} from "@/server/services/conversation-messages";
import { getConversation, listConversations } from "@/server/services/conversations";
import { getCustomer360 } from "@/server/services/customers";
import { listPendingApprovals } from "@/server/services/ai-approvals";
import { listMembers } from "@/server/services/memberships";
import { seedConversation, setupConversationTenants } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

type Ctx = Awaited<ReturnType<typeof requireOrganizationContext>>;

/**
 * Server-renders the real inbox components with real data from PostgreSQL, built exactly as the
 * inbox page builds its initial data (services -> serialize -> client view with initialData).
 */
describeDb("inbox server rendering", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
  });
  afterAll(disconnectDatabase);

  async function renderPane(ctx: Ctx, conversationId: string) {
    const initial = serialize({
      conversation: { conversation: await getConversation(ctx, conversationId) },
      messages: await listMessages(ctx, conversationId, { limit: 50, includeInternal: true }),
      events: await listConversationEvents(ctx, conversationId, DEFAULT_EVENTS_PARAMS),
      members: { members: await listMembers(ctx) },
      approvals: { approvals: await listPendingApprovals(ctx, conversationId) },
    });
    return renderToStaticMarkup(
      <QueryProvider organizationId={ctx.organization.id}>
        <ConversationPane
          conversationId={conversationId}
          initial={initial}
          currentUserId={ctx.user.id}
          can={{
            update: ctx.can("update_conversations"),
            assign: ctx.can("assign_conversations"),
            send: ctx.can("send_messages"),
          }}
          closeHref="/dashboard/inbox"
        />
      </QueryProvider>,
    );
  }

  it("renders the conversation with distinct customer, agent, note and system entries", async () => {
    const conversation = await seedConversation(t.orgA.id, t.customerA.id, {
      subject: "Login problem",
    });
    as(t.memberA);
    const ctx = await requireOrganizationContext();
    await sendMessage(ctx, conversation.id, {
      body: "I cannot log in",
      type: "MESSAGE",
      from: "CUSTOMER",
    });
    await sendMessage(ctx, conversation.id, {
      body: "Looking into it",
      type: "MESSAGE",
      from: "USER",
    });
    await sendMessage(ctx, conversation.id, {
      body: "Probably the SSO bug",
      type: "INTERNAL_NOTE",
      from: "USER",
    });

    const html = await renderPane(ctx, conversation.id);
    expect(html).toContain("Login problem");
    expect(html).toContain("Alice Anders");
    expect(html).toContain('aria-label="Customer message"');
    expect(html).toContain('aria-label="Agent message"');
    expect(html).toContain('aria-label="Internal note"');
    expect(html).toContain("Probably the SSO bug");
    expect(html).toContain("Send reply");
    expect(html).toContain("Assign to me");
  });

  it("shows an admin the full assignee picker", async () => {
    const own = await seedConversation(t.orgA.id, t.customerA.id);
    as(t.adminA);
    const ctx = await requireOrganizationContext();
    const html = await renderPane(ctx, own.id);
    expect(html).toContain("Unassigned");
    expect(html).toContain('id="ctl-assignee"');
    expect(html).toContain(">othermembera</option>");
  });

  it("another organization's conversation cannot produce initial data", async () => {
    const foreign = await seedConversation(t.orgB.id, t.customerB.id, { subject: "Secret B" });
    as(t.adminA);
    const ctx = await requireOrganizationContext();
    await expect(getConversation(ctx, foreign.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("renders the list with unread markers, preview and links keeping the current view", async () => {
    const conversation = await seedConversation(t.orgA.id, t.customerA.id, {
      subject: "Refund request",
    });
    as(t.memberA);
    const author = await requireOrganizationContext();
    await sendMessage(author, conversation.id, {
      body: "Where is my refund?",
      type: "MESSAGE",
      from: "CUSTOMER",
    });

    as(t.otherMemberA);
    const ctx = await requireOrganizationContext();
    const { items } = await listConversations(ctx, parseInboxParams({ view: "all" }).query);
    const html = renderToStaticMarkup(
      <ConversationList
        conversations={serialize(items)}
        selectedId={null}
        hrefFor={(id) => `/dashboard/inbox?view=all&c=${id}`}
      />,
    );
    expect(html).toContain("Refund request");
    expect(html).toContain("Where is my refund?");
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain(`/dashboard/inbox?view=all&amp;c=${conversation.id}`);
  });

  it("renders the Customer 360 conversations section from real data", async () => {
    await seedConversation(t.orgA.id, t.customerA.id, {
      subject: "Billing question",
      priority: "HIGH",
    });
    as(t.memberA);
    const ctx = await requireOrganizationContext();
    const data = serialize(await getCustomer360(ctx, t.customerA.id));
    const html = renderToStaticMarkup(
      <CustomerConversations
        customerId={t.customerA.id}
        conversations={data.conversations}
        total={data.counts.conversations}
        canCreate
      />,
    );
    expect(html).toContain("Billing question");
    expect(html).toContain(`/dashboard/inbox/new?customerId=${t.customerA.id}`);
  });
});
