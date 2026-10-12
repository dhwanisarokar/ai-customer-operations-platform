import { NotFoundError } from "@/server/errors";
import { knowledgeDocumentsRepository } from "@/server/repositories/knowledge-documents";
import type { PortalContext } from "./context";

/**
 * Help center: the organization's PUBLISHED knowledge only. Drafts and archived documents never match
 * (the repository filters on status, scoped by the portal organization), and the projection has no
 * embeddings, chunk data, authors, versions or any other staff-only metadata.
 */
export type HelpArticleSummary = {
  id: string;
  title: string;
  summary: string;
  publishedAt: string | null;
};
export type HelpArticle = HelpArticleSummary & { content: string };

const SUMMARY_CHARS = 200;

function summaryOf(description: string | null, content: string): string {
  const base = (description?.trim() || content.replace(/\s+/g, " ").trim()).slice(
    0,
    SUMMARY_CHARS + 1,
  );
  return base.length > SUMMARY_CHARS ? `${base.slice(0, SUMMARY_CHARS - 1)}…` : base;
}

export async function searchHelpArticles(
  ctx: PortalContext,
  query: { q?: string; page: number; pageSize: number },
) {
  const { items, total } = await knowledgeDocumentsRepository.listPublished(
    ctx.organization.id,
    query,
  );
  return {
    items: items.map((row): HelpArticleSummary => ({
      id: row.id,
      title: row.title,
      summary: summaryOf(row.description, row.content),
      publishedAt: row.publishedAt?.toISOString() ?? null,
    })),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

export async function getHelpArticle(ctx: PortalContext, articleId: string): Promise<HelpArticle> {
  const row = await knowledgeDocumentsRepository.findPublished(ctx.organization.id, articleId);
  if (!row) throw new NotFoundError("Article not found");
  return {
    id: row.id,
    title: row.title,
    summary: summaryOf(row.description, row.content),
    publishedAt: row.publishedAt?.toISOString() ?? null,
    content: row.content,
  };
}
