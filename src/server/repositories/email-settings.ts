import { getDb, type Db } from "@/db/client";
import type { EmailSettingsStatus } from "@/generated/prisma/client";

const select = {
  id: true,
  organizationId: true,
  enabled: true,
  status: true,
  statusDetail: true,
  statusCheckedAt: true,
  localPart: true,
  supportAddress: true,
  fromName: true,
} as const;

/** Every function is keyed by the organization id (or, for routing, by the globally unique address). */
export const emailSettingsRepository = {
  findByOrganization(organizationId: string, db: Db = getDb()) {
    return db.emailSettings.findUnique({ where: { organizationId }, select });
  },

  create(
    data: { organizationId: string; localPart: string; supportAddress: string; fromName: string },
    db: Db = getDb(),
  ) {
    return db.emailSettings.create({
      data: { ...data, status: "PENDING_VERIFICATION", enabled: false },
      select,
    });
  },

  /** A new address starts over: not verified, not enabled. */
  changeAddress(
    organizationId: string,
    data: { localPart: string; supportAddress: string; fromName: string },
    db: Db = getDb(),
  ) {
    return db.emailSettings.update({
      where: { organizationId },
      data: {
        ...data,
        status: "PENDING_VERIFICATION",
        statusDetail: null,
        statusCheckedAt: null,
        enabled: false,
        updatedAt: new Date(),
      },
      select,
    });
  },

  updateFromName(organizationId: string, fromName: string, db: Db = getDb()) {
    return db.emailSettings.update({
      where: { organizationId },
      data: { fromName, updatedAt: new Date() },
      select,
    });
  },

  /** Records a verification outcome. A failed or unverified address can never stay enabled (CHECK). */
  setStatus(
    organizationId: string,
    status: EmailSettingsStatus,
    statusDetail: string | null,
    db: Db = getDb(),
  ) {
    return db.emailSettings.update({
      where: { organizationId },
      data: {
        status,
        statusDetail,
        statusCheckedAt: new Date(),
        ...(status === "ACTIVE" ? {} : { enabled: false }),
        updatedAt: new Date(),
      },
      select,
    });
  },

  /** Turning on is conditional on ACTIVE (atomic); turning off is always allowed. True when applied. */
  async setEnabled(organizationId: string, enabled: boolean, db: Db = getDb()): Promise<boolean> {
    const result = await db.emailSettings.updateMany({
      where: { organizationId, ...(enabled ? { status: "ACTIVE" as const } : {}) },
      data: { enabled, updatedAt: new Date() },
    });
    return result.count === 1;
  },
};
