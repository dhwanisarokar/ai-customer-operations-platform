import { getDb } from "@/db/client";
import { Role } from "@/generated/prisma/enums";
import type { OrganizationRecord } from "./organizations";

export type MembershipWithOrganization = {
  id: string;
  role: Role;
  organization: OrganizationRecord;
};

export type MemberRecord = {
  userId: string;
  email: string;
  name: string | null;
  role: Role;
  joinedAt: Date;
};

const orgSelect = { id: true, name: true, slug: true, createdAt: true } as const;

const memberSelect = {
  role: true,
  createdAt: true,
  user: { select: { id: true, email: true, name: true } },
} as const;

type MemberRow = {
  role: Role;
  createdAt: Date;
  user: { id: string; email: string; name: string | null };
};

function toMember(row: MemberRow): MemberRecord {
  return {
    userId: row.user.id,
    email: row.user.email,
    name: row.user.name,
    role: row.role,
    joinedAt: row.createdAt,
  };
}

/**
 * Every function that reads or writes organization data takes an explicit organizationId.
 * Callers obtain it from a verified OrganizationContext, never from raw client input.
 */
export const membershipsRepository = {
  /** Tenant gate: the membership of `userId` in `organizationId`, or null. */
  findForUserInOrganization(
    userId: string,
    organizationId: string,
  ): Promise<MembershipWithOrganization | null> {
    return getDb().membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { id: true, role: true, organization: { select: orgSelect } },
    });
  },

  listForUser(userId: string): Promise<MembershipWithOrganization[]> {
    return getDb().membership.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
      select: { id: true, role: true, organization: { select: orgSelect } },
    });
  },

  async listMembers(organizationId: string): Promise<MemberRecord[]> {
    const rows = await getDb().membership.findMany({
      where: { organizationId },
      orderBy: { createdAt: "asc" },
      select: memberSelect,
    });
    return rows.map(toMember);
  },

  async findMember(organizationId: string, userId: string): Promise<MemberRecord | null> {
    const row = await getDb().membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: memberSelect,
    });
    return row ? toMember(row) : null;
  },

  async create(organizationId: string, userId: string, role: Role): Promise<void> {
    await getDb().membership.create({ data: { organizationId, userId, role } });
  },

  async updateRole(organizationId: string, userId: string, role: Role): Promise<void> {
    await getDb().membership.update({
      where: { userId_organizationId: { userId, organizationId } },
      data: { role },
    });
  },

  async remove(organizationId: string, userId: string): Promise<void> {
    await getDb().membership.delete({
      where: { userId_organizationId: { userId, organizationId } },
    });
  },

  /**
   * Atomically promotes `toUserId` to OWNER and demotes `fromUserId` to ADMIN. The guarded
   * updateMany fails the whole transaction if `fromUserId` is no longer the owner (e.g. a
   * concurrent transfer), so an organization can never end up with zero or two owners.
   */
  async transferOwnership(
    organizationId: string,
    fromUserId: string,
    toUserId: string,
  ): Promise<boolean> {
    return getDb()
      .$transaction(async (tx) => {
        const demoted = await tx.membership.updateMany({
          where: { organizationId, userId: fromUserId, role: Role.OWNER },
          data: { role: Role.ADMIN },
        });
        if (demoted.count !== 1) return false;
        const promoted = await tx.membership.updateMany({
          where: { organizationId, userId: toUserId },
          data: { role: Role.OWNER },
        });
        if (promoted.count !== 1) throw new TransferAbort();
        return true;
      })
      .catch((error: unknown) => {
        if (error instanceof TransferAbort) return false;
        throw error;
      });
  },
};

class TransferAbort extends Error {}
