import { getDb, type Db } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

const noteSelect = {
  id: true,
  content: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CustomerNoteSelect;

export type NoteRecord = Prisma.CustomerNoteGetPayload<{ select: typeof noteSelect }>;

export const customerNotesRepository = {
  /** The composite foreign key rejects a customer that belongs to another organization. */
  create(
    organizationId: string,
    customerId: string,
    authorId: string,
    content: string,
    db: Db = getDb(),
  ): Promise<NoteRecord> {
    return db.customerNote.create({
      data: { organizationId, customerId, authorId, content },
      select: noteSelect,
    });
  },

  async list(
    organizationId: string,
    customerId: string,
    page: { skip: number; take: number },
    db: Db = getDb(),
  ): Promise<{ items: NoteRecord[]; total: number }> {
    const where = { organizationId, customerId };
    const [items, total] = await Promise.all([
      db.customerNote.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: page.skip,
        take: page.take,
        select: noteSelect,
      }),
      db.customerNote.count({ where }),
    ]);
    return { items, total };
  },
};
