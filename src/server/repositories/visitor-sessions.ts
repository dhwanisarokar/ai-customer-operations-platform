import { getDb, type Db } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";

const sessionSelect = {
  id: true,
  organizationId: true,
  customerId: true,
  visitorName: true,
  visitorEmail: true,
  lastSeenAt: true,
  expiresAt: true,
  revokedAt: true,
} satisfies Prisma.VisitorSessionSelect;

export type VisitorSessionRecord = Prisma.VisitorSessionGetPayload<{
  select: typeof sessionSelect;
}>;

export const visitorSessionsRepository = {
  create(organizationId: string, data: { tokenHash: string; expiresAt: Date }, db: Db = getDb()) {
    return db.visitorSession.create({
      data: { organizationId, ...data },
      select: sessionSelect,
    });
  },

  /** The only lookup by credential. The caller verifies expiry, revocation and the widget. */
  findByTokenHash(tokenHash: string, db: Db = getDb()) {
    return db.visitorSession.findUnique({ where: { tokenHash }, select: sessionSelect });
  },

  findById(organizationId: string, id: string, db: Db = getDb()) {
    return db.visitorSession.findFirst({ where: { id, organizationId }, select: sessionSelect });
  },

  touch(id: string, now: Date, expiresAt: Date, db: Db = getDb()) {
    return db.visitorSession.update({
      where: { id },
      data: { lastSeenAt: now, expiresAt },
      select: { id: true },
    });
  },

  revoke(organizationId: string, id: string, now: Date, db: Db = getDb()) {
    return db.visitorSession.updateMany({
      where: { id, organizationId },
      data: { revokedAt: now },
    });
  },

  /** Links the session to a customer only if it has none yet (race safe). True when this call linked it. */
  async linkCustomerIfUnset(
    organizationId: string,
    id: string,
    customerId: string,
    db: Db = getDb(),
  ): Promise<boolean> {
    const result = await db.visitorSession.updateMany({
      where: { id, organizationId, customerId: null },
      data: { customerId },
    });
    return result.count === 1;
  },

  setIdentity(
    organizationId: string,
    id: string,
    data: { customerId?: string; visitorName?: string; visitorEmail?: string },
    db: Db = getDb(),
  ) {
    return db.visitorSession.updateMany({ where: { id, organizationId }, data });
  },
};
