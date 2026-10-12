import { getDb, type Db } from "@/db/client";

/**
 * Customer portal tables. Every function that reads a customer-owned row takes the organization id
 * (and, for portal access, the customer id) in the WHERE clause. There is no lookup by id alone.
 */

export const portalSettingsRepository = {
  findByOrganization(organizationId: string, db: Db = getDb()) {
    return db.portalSettings.findUnique({
      where: { organizationId },
      select: { id: true, organizationId: true, enabled: true },
    });
  },

  create(organizationId: string, enabled: boolean, db: Db = getDb()) {
    return db.portalSettings.create({
      data: { organizationId, enabled },
      select: { id: true, organizationId: true, enabled: true },
    });
  },

  update(organizationId: string, enabled: boolean, db: Db = getDb()) {
    return db.portalSettings.update({
      where: { organizationId },
      data: { enabled, updatedAt: new Date() },
      select: { id: true, organizationId: true, enabled: true },
    });
  },
};

export const portalOrganizationsRepository = {
  /** An organization with its portal switch, by its public slug. Unknown slugs are simply null. */
  async findBySlug(slug: string, db: Db = getDb()) {
    const row = await db.organization.findUnique({
      where: { slug },
      select: { id: true, name: true, slug: true, portalSettings: { select: { enabled: true } } },
    });
    return row
      ? {
          id: row.id,
          name: row.name,
          slug: row.slug,
          portalEnabled: row.portalSettings?.enabled === true,
        }
      : null;
  },
};

export const portalAccountsRepository = {
  findByUser(organizationId: string, userId: string, db: Db = getDb()) {
    return db.customerPortalAccount.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      select: { id: true, customerId: true, userId: true, organizationId: true },
    });
  },

  findByCustomer(organizationId: string, customerId: string, db: Db = getDb()) {
    return db.customerPortalAccount.findUnique({
      where: { organizationId_customerId: { organizationId, customerId } },
      select: { id: true, customerId: true, userId: true, createdAt: true },
    });
  },

  /** The unique constraints (identity per organization, customer per organization) reject conflicts. */
  create(data: { organizationId: string; customerId: string; userId: string }, db: Db = getDb()) {
    return db.customerPortalAccount.create({
      data,
      select: { id: true, customerId: true, userId: true, organizationId: true },
    });
  },

  async deleteByCustomer(organizationId: string, customerId: string, db: Db = getDb()) {
    const result = await db.customerPortalAccount.deleteMany({
      where: { organizationId, customerId },
    });
    return result.count;
  },
};

export const portalInvitesRepository = {
  create(
    data: {
      organizationId: string;
      customerId: string;
      tokenHash: string;
      createdByUserId: string;
      expiresAt: Date;
    },
    db: Db = getDb(),
  ) {
    return db.portalInvite.create({ data, select: { id: true, expiresAt: true } });
  },

  findByTokenHash(organizationId: string, tokenHash: string, db: Db = getDb()) {
    return db.portalInvite.findFirst({
      where: { organizationId, tokenHash },
      select: { id: true, customerId: true, expiresAt: true, usedAt: true },
    });
  },

  /** Single-use: true only for the one caller that flips `usedAt` from null (atomic). */
  async markUsed(organizationId: string, id: string, at: Date, db: Db = getDb()): Promise<boolean> {
    const result = await db.portalInvite.updateMany({
      where: { id, organizationId, usedAt: null, expiresAt: { gt: at } },
      data: { usedAt: at },
    });
    return result.count === 1;
  },

  /** Pending (unused, unexpired) invitations of a customer, newest first. */
  listPending(organizationId: string, customerId: string, now: Date, db: Db = getDb()) {
    return db.portalInvite.findMany({
      where: { organizationId, customerId, usedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
      select: { id: true, expiresAt: true, createdAt: true },
    });
  },

  /** Invalidates every pending invitation of a customer (a new invite or a revoked access). */
  async expirePending(organizationId: string, customerId: string, now: Date, db: Db = getDb()) {
    const result = await db.portalInvite.updateMany({
      where: { organizationId, customerId, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    return result.count;
  },
};
