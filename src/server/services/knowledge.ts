import { transaction } from "@/db/client";
import type {
  CreateDocumentInput,
  ListDocumentsQuery,
  UpdateDocumentInput,
} from "@/features/knowledge/schemas";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { toPage, type Page } from "@/server/http/pagination";
import { knowledgeChunksRepository } from "@/server/repositories/knowledge-chunks";
import {
  knowledgeDocumentsRepository,
  type KnowledgeDocumentDetail,
  type KnowledgeDocumentListItem,
} from "@/server/repositories/knowledge-documents";
import { prepareChunks } from "./knowledge-indexing";

const log = createLogger("knowledge");

/**
 * Lifecycle (see docs/knowledge-base.md):
 *   DRAFT --publish--> PUBLISHED --unpublish--> DRAFT
 *   any --archive--> ARCHIVED --unpublish (restore)--> DRAFT
 *
 * Consistency rule: a document's chunks always correspond to its CURRENT title and content, or do
 * not exist. Whenever live (PUBLISHED) content changes, the new chunks are embedded first (external
 * call, nothing written yet) and then swapped in together with the content change in ONE database
 * transaction. If embedding fails the operation fails and the previous content and chunks stay.
 */

export async function requireDocument(
  ctx: OrganizationContext,
  documentId: string,
  db?: Parameters<typeof knowledgeDocumentsRepository.findById>[2],
): Promise<KnowledgeDocumentDetail> {
  const document = await knowledgeDocumentsRepository.findById(ctx.organization.id, documentId, db);
  if (!document) throw new NotFoundError("Document not found");
  return document;
}

export async function createDocument(ctx: OrganizationContext, input: CreateDocumentInput) {
  ctx.require("edit_knowledge");
  const document = await knowledgeDocumentsRepository.create(ctx.organization.id, {
    ...input,
    userId: ctx.user.id,
  });
  log.info({ organizationId: ctx.organization.id, documentId: document.id }, "document created");
  return document;
}

export async function listDocuments(
  ctx: OrganizationContext,
  query: ListDocumentsQuery,
): Promise<Page<KnowledgeDocumentListItem>> {
  ctx.require("view_knowledge");
  const { items, total } = await knowledgeDocumentsRepository.list(ctx.organization.id, query);
  return toPage(items, total, query);
}

export async function getDocument(ctx: OrganizationContext, documentId: string) {
  ctx.require("view_knowledge");
  return requireDocument(ctx, documentId);
}

export async function updateDocument(
  ctx: OrganizationContext,
  documentId: string,
  input: UpdateDocumentInput,
): Promise<KnowledgeDocumentDetail> {
  ctx.require("edit_knowledge");
  const organizationId = ctx.organization.id;
  const current = await requireDocument(ctx, documentId);

  // Changing anything that is (or was) live is an admin action: it changes what the AI says.
  if (current.status !== "DRAFT") ctx.require("publish_knowledge");

  const titleChanged = input.title !== undefined && input.title !== current.title;
  const contentChanged = input.content !== undefined && input.content !== current.content;
  const descriptionChanged =
    input.description !== undefined && input.description !== current.description;
  if (!titleChanged && !contentChanged && !descriptionChanged) return current;

  const nextTitle = input.title ?? current.title;
  const nextContent = input.content ?? current.content;
  const reindex = current.status === "PUBLISHED" && (titleChanged || contentChanged);
  const bumpVersion = titleChanged || contentChanged;

  // External step first: nothing is written if embedding fails.
  const chunks = reindex ? await prepareChunks(nextTitle, nextContent) : null;

  await transaction(async (tx) => {
    const applied = await knowledgeDocumentsRepository.updateIfVersion(
      organizationId,
      documentId,
      current.contentVersion,
      {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        updatedByUserId: ctx.user.id,
        bumpVersion,
      },
      tx,
    );
    if (!applied)
      throw new ConflictError("The document was changed by someone else. Reload and retry.");

    if (chunks) {
      await knowledgeChunksRepository.replaceForDocument(
        organizationId,
        documentId,
        current.contentVersion + 1,
        chunks,
        tx,
      );
    }
  });

  log.info(
    { organizationId, documentId, actorId: ctx.user.id, reindexed: reindex },
    "document updated",
  );
  return requireDocument(ctx, documentId);
}

/**
 * Publishing makes a document searchable. Embeddings are generated BEFORE the status changes, so
 * a failed publish leaves the document a clean draft (never "published without vectors").
 */
export async function publishDocument(ctx: OrganizationContext, documentId: string) {
  ctx.require("publish_knowledge");
  const organizationId = ctx.organization.id;
  const current = await requireDocument(ctx, documentId);

  if (current.status === "PUBLISHED") return current; // idempotent
  if (current.status === "ARCHIVED") {
    throw new ConflictError("Restore the archived document (unpublish) before publishing it");
  }

  const chunks = await prepareChunks(current.title, current.content);
  if (chunks.length === 0)
    throw new ConflictError("A document without content cannot be published");

  await transaction(async (tx) => {
    const applied = await knowledgeDocumentsRepository.updateIfVersion(
      organizationId,
      documentId,
      current.contentVersion,
      {
        status: "PUBLISHED",
        publishedAt: new Date(),
        updatedByUserId: ctx.user.id,
        bumpVersion: false,
      },
      tx,
    );
    if (!applied)
      throw new ConflictError("The document was changed by someone else. Reload and retry.");
    await knowledgeChunksRepository.replaceForDocument(
      organizationId,
      documentId,
      current.contentVersion,
      chunks,
      tx,
    );
  });

  log.info(
    { organizationId, documentId, actorId: ctx.user.id, chunks: chunks.length },
    "document published",
  );
  return requireDocument(ctx, documentId);
}

/** Back to DRAFT (also restores an archived document). Embeddings are removed immediately. */
export async function unpublishDocument(ctx: OrganizationContext, documentId: string) {
  ctx.require("publish_knowledge");
  return moveOutOfPublished(ctx, documentId, "DRAFT");
}

export async function archiveDocument(ctx: OrganizationContext, documentId: string) {
  ctx.require("publish_knowledge");
  return moveOutOfPublished(ctx, documentId, "ARCHIVED");
}

async function moveOutOfPublished(
  ctx: OrganizationContext,
  documentId: string,
  target: "DRAFT" | "ARCHIVED",
) {
  const organizationId = ctx.organization.id;
  const current = await requireDocument(ctx, documentId);
  if (current.status === target) return current;

  await transaction(async (tx) => {
    const applied = await knowledgeDocumentsRepository.updateIfVersion(
      organizationId,
      documentId,
      current.contentVersion,
      { status: target, publishedAt: null, updatedByUserId: ctx.user.id, bumpVersion: false },
      tx,
    );
    if (!applied)
      throw new ConflictError("The document was changed by someone else. Reload and retry.");
    await knowledgeChunksRepository.deleteForDocument(organizationId, documentId, tx);
  });

  log.info(
    { organizationId, documentId, actorId: ctx.user.id, status: target },
    "document status changed",
  );
  return requireDocument(ctx, documentId);
}

/** Permanently deletes the document; its chunks are removed by the foreign key cascade. */
export async function deleteDocument(ctx: OrganizationContext, documentId: string) {
  ctx.require("publish_knowledge");
  const deleted = await knowledgeDocumentsRepository.delete(ctx.organization.id, documentId);
  if (!deleted) throw new NotFoundError("Document not found");
  log.info(
    { organizationId: ctx.organization.id, documentId, actorId: ctx.user.id },
    "document deleted",
  );
}
