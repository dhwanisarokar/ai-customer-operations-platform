import { getDb, type Db } from "@/db/client";

const tagSelect = { id: true, name: true, createdAt: true } as const;

export type TagRecord = { id: string; name: string; createdAt: Date };
export type TagWithUsage = TagRecord & { customerCount: number };

/** Every function is scoped by `organizationId`; tags never resolve across organizations. */
export const tagsRepository = {
  async list(organizationId: string, db: Db = getDb()): Promise<TagWithUsage[]> {
    const rows = await db.tag.findMany({
      where: { organizationId },
      orderBy: { normalizedName: "asc" },
      select: { ...tagSelect, _count: { select: { customers: true } } },
    });
    return rows.map(({ _count, ...tag }) => ({ ...tag, customerCount: _count.customers }));
  },

  findById(organizationId: string, id: string, db: Db = getDb()): Promise<TagRecord | null> {
    return db.tag.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: tagSelect,
    });
  },

  findByNormalizedName(
    organizationId: string,
    normalizedName: string,
    db: Db = getDb(),
  ): Promise<TagRecord | null> {
    return db.tag.findUnique({
      where: { organizationId_normalizedName: { organizationId, normalizedName } },
      select: tagSelect,
    });
  },

  create(
    organizationId: string,
    data: { name: string; normalizedName: string },
    db: Db = getDb(),
  ): Promise<TagRecord> {
    return db.tag.create({ data: { ...data, organizationId }, select: tagSelect });
  },

  /** Returns the existing tag with this normalized name, or creates it (single atomic upsert). */
  findOrCreate(
    organizationId: string,
    data: { name: string; normalizedName: string },
    db: Db = getDb(),
  ): Promise<TagRecord> {
    return db.tag.upsert({
      where: {
        organizationId_normalizedName: { organizationId, normalizedName: data.normalizedName },
      },
      create: { ...data, organizationId },
      update: {},
      select: tagSelect,
    });
  },

  rename(
    organizationId: string,
    id: string,
    data: { name: string; normalizedName: string },
    db: Db = getDb(),
  ): Promise<TagRecord> {
    return db.tag.update({
      where: { id_organizationId: { id, organizationId } },
      data,
      select: tagSelect,
    });
  },

  /** Deletes the tag; customer links are removed by the ON DELETE CASCADE foreign key. */
  async delete(organizationId: string, id: string, db: Db = getDb()): Promise<boolean> {
    const { count } = await db.tag.deleteMany({ where: { id, organizationId } });
    return count === 1;
  },

  async listForCustomer(
    organizationId: string,
    customerId: string,
    db: Db = getDb(),
  ): Promise<TagRecord[]> {
    const links = await db.customerTag.findMany({
      where: { organizationId, customerId },
      orderBy: { tag: { name: "asc" } },
      select: { tag: { select: tagSelect } },
    });
    return links.map((link) => link.tag);
  },

  /** Throws a unique violation (P2002) if the tag is already assigned. */
  async assign(
    organizationId: string,
    customerId: string,
    tagId: string,
    db: Db = getDb(),
  ): Promise<void> {
    await db.customerTag.create({ data: { organizationId, customerId, tagId } });
  },

  async unassign(
    organizationId: string,
    customerId: string,
    tagId: string,
    db: Db = getDb(),
  ): Promise<boolean> {
    const { count } = await db.customerTag.deleteMany({
      where: { organizationId, customerId, tagId },
    });
    return count === 1;
  },
};
