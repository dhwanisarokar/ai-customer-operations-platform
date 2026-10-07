import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import { ConversationList } from "@/features/conversations/components/conversation-list";
import { CustomerConversations } from "@/features/conversations/components/customer-conversations";
import { requireOrganizationContext } from "@/server/auth/context";
import { getCustomer360 } from "@/server/services/customers";
import { listConversations } from "@/server/services/conversations";
import { sendMessage } from "@/server/services/conversation-messages";
import { parseInboxParams } from "@/features/conversations/inbox-params";
import { seedConversation, setupConversationTenants } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);
// Client components call useRouter; server-side rendering only needs it to exist.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

/**
 * Server-renders the real inbox components with real data from PostgreSQL. This covers the
 * composition the pages perform (queries -> props -> markup) without needing a Clerk session.
 */
describeDb("inbox server rendering", () => {
  let t: Awaited<ReturnType<typeof setupConversationTenants>>;

  beforeEach(async () => {
    await resetDatabase();
    t = await setupConversationTenants();
  });
  afterAll(disconnectDatabase);

  it("renders the conversation detail with distinct customer, agent, note and system entries", async () => {
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

    const element = await ConversationDetail({
      ctx,
      conversationId: conversation.id,
      messageLimit: 50,
      closeHref: "/dashboard/inbox",
      loadMoreHref: "/x",
    });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Login problem");
    expect(html).toContain("Alice Anders");
    expect(html).toContain('aria-label="Customer message"');
    expect(html).toContain('aria-label="Agent message"');
    expect(html).toContain('aria-label="Internal note"');
    expect(html).toContain("Probably the SSO bug");
    expect(html).toContain("Only visible to your team");
    expect(html).toContain("Send reply");
    // Assignment control for a plain member is the self-service button.
    expect(html).toContain("Assign to me");
  });

  it("shows an admin the full assignee picker with member names, and a not-found state for foreign ids", async () => {
    const own = await seedConversation(t.orgA.id, t.customerA.id);
    const foreign = await seedConversation(t.orgB.id, t.customerB.id, {
      subject: "Secret B subject",
    });
    as(t.adminA);
    const ctx = await requireOrganizationContext();

    const ownHtml = renderToStaticMarkup(
      await ConversationDetail({
        ctx,
        conversationId: own.id,
        messageLimit: 50,
        closeHref: "/i",
        loadMoreHref: "/x",
      }),
    );
    expect(ownHtml).toContain(">othermembera</option>");
    expect(ownHtml).toContain("Unassigned");

    const foreignHtml = renderToStaticMarkup(
      await ConversationDetail({
        ctx,
        conversationId: foreign.id,
        messageLimit: 50,
        closeHref: "/i",
        loadMoreHref: "/x",
      }),
    );
    expect(foreignHtml).toContain("Conversation not found");
    expect(foreignHtml).not.toContain("Secret B subject");
  });

  it("renders the list with unread markers, preview and links that keep the current view", async () => {
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
        conversations={items}
        selectedId={null}
        hrefFor={(id) => `/dashboard/inbox?view=all&c=${id}`}
      />,
    );
    expect(html).toContain("Refund request");
    expect(html).toContain("Where is my refund?");
    expect(html).toContain('aria-label="Unread"');
    expect(html).toContain(`/dashboard/inbox?view=all&amp;c=${conversation.id}`);

    // The author already read it.
    as(t.memberA);
    const own = await listConversations(
      await requireOrganizationContext(),
      parseInboxParams({ view: "all" }).query,
    );
    expect(
      renderToStaticMarkup(
        <ConversationList conversations={own.items} selectedId={null} hrefFor={(id) => id} />,
      ),
    ).not.toContain('aria-label="Unread"');
  });

  it("renders the Customer 360 conversations section from real data", async () => {
    await seedConversation(t.orgA.id, t.customerA.id, {
      subject: "Billing question",
      priority: "HIGH",
    });
    as(t.memberA);
    const ctx = await requireOrganizationContext();
    const data = await getCustomer360(ctx, t.customerA.id);
    const html = renderToStaticMarkup(
      <CustomerConversations
        customerId={t.customerA.id}
        conversations={data.conversations}
        total={data.counts.conversations}
        canCreate
      />,
    );
    expect(html).toContain("Conversations (1)");
    expect(html).toContain("Billing question");
    expect(html).toContain("High");
    expect(html).toContain(`/dashboard/inbox/new?customerId=${t.customerA.id}`);
  });
});
