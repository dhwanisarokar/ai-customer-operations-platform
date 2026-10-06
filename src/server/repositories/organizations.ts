import { getDb } from "@/db/client";
import { Role } from "@/generated/prisma/enums";

export type OrganizationRecord = { id: string; name: string; slug: string; createdAt: Date };

const select = { id: true, name: true, slug: true, createdAt: true } as const;

export const organizationsRepository = {
  /**
   * Creates the organization and its OWNER membership in a single nested write, which Prisma
   * executes atomically: either both rows exist or neither does.
   */
  createWithOwner(input: {
    name: string;
    slug: string;
    ownerUserId: string;
  }): Promise<OrganizationRecord> {
    return getDb().organization.create({
      data: {
        name: input.name,
        slug: input.slug,
        memberships: { create: { userId: input.ownerUserId, role: Role.OWNER } },
      },
      select,
    });
  },
};
