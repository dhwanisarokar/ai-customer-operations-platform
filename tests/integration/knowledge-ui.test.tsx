import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_EVENTS_PARAMS } from "@/features/conversations/api/types";
import { ConversationPane } from "@/features/conversations/components/conversation-pane";
import { KnowledgeListView } from "@/features/knowledge/components/knowledge-list-view";
import { listDocumentsQuerySchema } from "@/features/knowledge/schemas";
import { QueryProvider } from "@/lib/query/query-provider";
import { serialize } from "@/lib/query/serialize";
import { requireOrganizationContext } from "@/server/auth/context";
import { generateAiReply } from "@/server/services/ai-reply";
import { listConversationEvents, listMessages } from "@/server/services/conversation-messages";
import { getConversation } from "@/server/services/conversations";
import { listDocuments } from "@/server/services/knowledge";
import { listMembers } from "@/server/services/memberships";
import { installFakeAi, uninstallFakeAi } from "../helpers/ai";
import { seedConversation, seedMessage } from "../helpers/conversations";
import { describeDb, disconnectDatabase, resetDatabase } from "../helpers/db";
import { REFUND_DOC, createPublishedDocument, setupAiTenants } from "../helpers/knowledge";
import { as } from "../helpers/tenants";

vi.mock("@/server/auth/identity", async () => (await import("../helpers/mocks")).identityMock);
vi.mock(
  "@/server/auth/active-organization",
  async () => (await import("../helpers/mocks")).activeOrganizationMock,
);

/** Server-renders the real knowledge and AI conversation UI with real data (no Clerk session). */
describeDb("knowledge and AI UI server rendering", () => {
  let t: Awaited<ReturnType<typeof setupAiTenants>>;

  beforeEach(async () => {
    await resetDatabase();
    t = await setupAiTenants();
    installFakeAi();
  });
  afterEach(uninstallFakeAi);
  afterAll(disconnectDatabase);

  it("renders the knowledge list view with status, author and indexed chunk counts", async () => {
    as(t.adminA);
    const ctx = await requireOrganizationContext();
    await createPublishedDocument(ctx, REFUND_DOC);
    const { createDocument } = await import("@/server/services/knowledge");
    await createDocument(ctx, { title: "Draft FAQ", description: "wip", content: "Questions." });

    const query = listDocumentsQuerySchema.parse({ sort: "title", order: "asc" });
    const html = renderToStaticMarkup(
      <QueryProvider organizationId={ctx.organization.id}>
        <KnowledgeListView
          query={query}
          params={{}}
          initialData={serialize(await listDocuments(ctx, query))}
          filtered={false}
          canCreate
        />
      </QueryProvider>,
    );
    expect(html).toContain("Draft FAQ");
    expect(html).toContain("Refund policy");
    expect(html).toContain("Published");
    expect(html).toContain("Draft");
    expect(html).toContain("admina");
  });

  it("renders an AI reply in the conversation as 'AI Agent' with its real source document", async () => {
    as(t.adminA);
    const adminCtx = await requireOrganizationContext();
    await createPublishedDocument(adminCtx, REFUND_DOC);
    const conversation = await seedConversation(t.orgA.id, t.customerA.id, { subject: "Refunds" });
    await seedMessage(t.orgA.id, conversation.id, {
      body: "How long do refunds take?",
      senderType: "CUSTOMER",
    });

    as(t.memberA);
    const ctx = await requireOrganizationContext();
    await generateAiReply(ctx, conversation.id);

    const initial = serialize({
      conversation: { conversation: await getConversation(ctx, conversation.id) },
      messages: await listMessages(ctx, conversation.id, { limit: 50, includeInternal: true }),
      events: await listConversationEvents(ctx, conversation.id, DEFAULT_EVENTS_PARAMS),
      members: { members: await listMembers(ctx) },
    });
    const html = renderToStaticMarkup(
      <QueryProvider organizationId={ctx.organization.id}>
        <ConversationPane
          conversationId={conversation.id}
          initial={initial}
          currentUserId={ctx.user.id}
          can={{ update: true, assign: false, send: true }}
          closeHref="/i"
        />
      </QueryProvider>,
    );
    expect(html).toContain('aria-label="AI message"');
    expect(html).toContain("AI Agent");
    expect(html).toContain("Based on:");
    expect(html).toContain("Refund policy");
    expect(html).toContain("Ask AI");
    // Never presented as a human member.
    expect(html).not.toContain('aria-label="Agent message"');
  });
});
