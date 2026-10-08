import { getDb, type Db } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

const automationSelect = {
  id: true,
  name: true,
  description: true,
  enabled: true,
  triggerType: true,
  conditions: true,
  actions: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AutomationSelect;

export type AutomationRecord = Prisma.AutomationGetPayload<{ select: typeof automationSelect }>;

export type AutomationData = {
  name: string;
  description: string | null;
  enabled: boolean;
  triggerType: string;
  conditions: Prisma.InputJsonValue;
  actions: Prisma.InputJsonValue;
};

/** Every query is scoped by organizationId: another tenant's id is simply "not found". */
export const automationsRepository = {
  create(
    organizationId: string,
    createdByUserId: string,
    data: AutomationData,
    db: Db = getDb(),
  ): Promise<AutomationRecord> {
    return db.automation.create({
      data: { organizationId, createdByUserId, ...data },
      select: automationSelect,
    });
  },

  findById(organizationId: string, id: string, db: Db = getDb()): Promise<AutomationRecord | null> {
    return db.automation.findFirst({ where: { id, organizationId }, select: automationSelect });
  },

  async list(
    organizationId: string,
    page: { skip: number; take: number },
    db: Db = getDb(),
  ): Promise<{ items: AutomationRecord[]; total: number }> {
    const where = { organizationId };
    const [items, total] = await Promise.all([
      db.automation.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
        select: automationSelect,
      }),
      db.automation.count({ where }),
    ]);
    return { items, total };
  },

  listEnabledForTrigger(
    organizationId: string,
    triggerType: string,
    db: Db = getDb(),
  ): Promise<AutomationRecord[]> {
    return db.automation.findMany({
      where: { organizationId, enabled: true, triggerType },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: automationSelect,
    });
  },

  async update(
    organizationId: string,
    id: string,
    data: Partial<AutomationData>,
    db: Db = getDb(),
  ): Promise<AutomationRecord | null> {
    const result = await db.automation.updateMany({
      where: { id, organizationId },
      data: { ...data, updatedAt: new Date() },
    });
    return result.count === 1 ? automationsRepository.findById(organizationId, id, db) : null;
  },

  async delete(organizationId: string, id: string, db: Db = getDb()): Promise<boolean> {
    const result = await db.automation.deleteMany({ where: { id, organizationId } });
    return result.count === 1;
  },
};
