import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import { KnowledgeTable } from "@/features/knowledge/components/knowledge-table";
import { requireOrganizationContext } from "@/server/auth/context";
import { generateAiReply } from "@/server/services/ai-reply";
import { listDocuments } from "@/server/services/knowledge";
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

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

  it("renders the knowledge table with status, author and indexed chunk counts", async () => {
    as(t.adminA);
    const ctx = await requireOrganizationContext();
    await createPublishedDocument(ctx, REFUND_DOC);
    const { createDocument } = await import("@/server/services/knowledge");
    await createDocument(ctx, { title: "Draft FAQ", description: "wip", content: "Questions." });

    const page = await listDocuments(ctx, { page: 1, pageSize: 25, sort: "title", order: "asc" });
    const html = renderToStaticMarkup(<KnowledgeTable documents={page.items} />);
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

    const html = renderToStaticMarkup(
      await ConversationDetail({
        ctx,
        conversationId: conversation.id,
        messageLimit: 50,
        closeHref: "/i",
        loadMoreHref: "/x",
      }),
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
