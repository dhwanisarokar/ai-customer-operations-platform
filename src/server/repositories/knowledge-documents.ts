import { getDb, type Db } from "@/db/client";
import type { KnowledgeDocumentStatus, Prisma } from "@/generated/prisma/client";
import type { ListDocumentsQuery } from "@/features/knowledge/schemas";
import { escapeLike, searchTokens } from "./search";

/**
 * Tenant rule: every function takes `organizationId` and filters or keys by it (composite
 * id_organizationId key). There is no lookup by id alone.
 */

const person = { select: { id: true, name: true, email: true } } as const;

const listSelect = {
  id: true,
  title: true,
  description: true,
  status: true,
  contentVersion: true,
  publishedAt: true,
  createdAt: true,
  updatedAt: true,
  createdBy: person,
  _count: { select: { chunks: true } },
} satisfies Prisma.KnowledgeDocumentSelect;

const detailSelect = {
  ...listSelect,
  content: true,
  updatedBy: person,
} satisfies Prisma.KnowledgeDocumentSelect;

type ListRow = Prisma.KnowledgeDocumentGetPayload<{ select: typeof listSelect }>;
type DetailRow = Prisma.KnowledgeDocumentGetPayload<{ select: typeof detailSelect }>;

export type KnowledgeDocumentListItem = Omit<ListRow, "_count"> & { chunkCount: number };
export type KnowledgeDocumentDetail = Omit<DetailRow, "_count"> & { chunkCount: number };

function withChunkCount<T extends { _count: { chunks: number } }>(row: T) {
  const { _count, ...rest } = row;
  return { ...rest, chunkCount: _count.chunks };
}

export const knowledgeDocumentsRepository = {
  async create(
    organizationId: string,
    data: { title: string; description: string | null; content: string; userId: string },
    db: Db = getDb(),
  ): Promise<KnowledgeDocumentDetail> {
    const row = await db.knowledgeDocument.create({
      data: {
        organizationId,
        title: data.title,
        description: data.description,
        content: data.content,
        createdByUserId: data.userId,
        updatedByUserId: data.userId,
      },
      select: detailSelect,
    });
    return withChunkCount(row);
  },

  async findById(
    organizationId: string,
    id: string,
    db: Db = getDb(),
  ): Promise<KnowledgeDocumentDetail | null> {
    const row = await db.knowledgeDocument.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: detailSelect,
    });
    return row ? withChunkCount(row) : null;
  },

  /**
   * Optimistic update: applies only if the document is still at `expectedVersion` (so a concurrent
   * edit makes this a no-op and returns false). `contentChanged` bumps contentVersion.
   */
  async updateIfVersion(
    organizationId: string,
    id: string,
    expectedVersion: number,
    changes: Partial<{
      title: string;
      description: string | null;
      content: string;
      status: KnowledgeDocumentStatus;
      publishedAt: Date | null;
    }> & { updatedByUserId: string; bumpVersion: boolean },
    db: Db = getDb(),
  ): Promise<boolean> {
    const { bumpVersion, ...data } = changes;
    const { count } = await db.knowledgeDocument.updateMany({
      where: { id, organizationId, contentVersion: expectedVersion },
      data: {
        ...data,
        updatedAt: new Date(),
        ...(bumpVersion ? { contentVersion: { increment: 1 } } : {}),
      },
    });
    return count === 1;
  },

  async delete(organizationId: string, id: string, db: Db = getDb()): Promise<boolean> {
    const { count } = await db.knowledgeDocument.deleteMany({ where: { id, organizationId } });
    return count === 1;
  },

  async list(
    organizationId: string,
    query: ListDocumentsQuery,
    db: Db = getDb(),
  ): Promise<{ items: KnowledgeDocumentListItem[]; total: number }> {
    const and: Prisma.KnowledgeDocumentWhereInput[] = [];
    if (query.status?.length) and.push({ status: { in: query.status } });
    for (const raw of searchTokens(query.q)) {
      const term = escapeLike(raw);
      and.push({
        OR: [
          { title: { contains: term, mode: "insensitive" } },
          { description: { contains: term, mode: "insensitive" } },
          { content: { contains: term, mode: "insensitive" } },
        ],
      });
    }
    const where = { organizationId, AND: and };

    const [rows, total] = await Promise.all([
      db.knowledgeDocument.findMany({
        where,
        orderBy: [{ [query.sort]: query.order }, { id: query.order }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: listSelect,
      }),
      db.knowledgeDocument.count({ where }),
    ]);
    return { items: rows.map(withChunkCount), total };
  },
};
