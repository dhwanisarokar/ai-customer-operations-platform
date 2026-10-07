import { getDb, type Db } from "@/db/client";
import type { ActivityActorType, ActivityType, Prisma } from "@/generated/prisma/client";

const activitySelect = {
  id: true,
  type: true,
  title: true,
  description: true,
  metadata: true,
  actorType: true,
  actorId: true,
  createdAt: true,
} satisfies Prisma.CustomerActivitySelect;

export type ActivityRecord = Prisma.CustomerActivityGetPayload<{ select: typeof activitySelect }>;

export type NewActivity = {
  type: ActivityType;
  title: string;
  description?: string | null;
  metadata?: Prisma.InputJsonValue;
  actorType: ActivityActorType;
  actorId: string | null;
};

export const customerActivitiesRepository = {
  /**
   * Appends a timeline entry and bumps the customer's denormalized `lastActivityAt`. Call it with
   * the same transaction client as the change it describes so both commit (or fail) together.
   * The composite foreign key rejects a customer that belongs to another organization.
   */
  async record(
    organizationId: string,
    customerId: string,
    activity: NewActivity,
    db: Db = getDb(),
  ): Promise<ActivityRecord> {
    const created = await db.customerActivity.create({
      data: {
        organizationId,
        customerId,
        type: activity.type,
        title: activity.title,
        description: activity.description ?? null,
        ...(activity.metadata !== undefined ? { metadata: activity.metadata } : {}),
        actorType: activity.actorType,
        actorId: activity.actorId,
      },
      select: activitySelect,
    });
    await db.customer.updateMany({
      where: { id: customerId, organizationId },
      data: { lastActivityAt: created.createdAt },
    });
    return created;
  },

  /** Newest first. `id` breaks ties between entries created in the same millisecond. */
  async list(
    organizationId: string,
    customerId: string,
    page: { skip: number; take: number },
    db: Db = getDb(),
  ): Promise<{ items: ActivityRecord[]; total: number }> {
    const where = { organizationId, customerId };
    const [items, total] = await Promise.all([
      db.customerActivity.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: page.skip,
        take: page.take,
        select: activitySelect,
      }),
      db.customerActivity.count({ where }),
    ]);
    return { items, total };
  },
};
