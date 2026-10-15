import { getDb, type Db } from "@/db/client";
import { Prisma, type CustomerStatus } from "@/generated/prisma/client";
import { escapeLike, searchTokens } from "./search";
import type { ListCustomersQuery } from "@/features/customers/schemas";

/**
 * Tenant rule for this file: every function takes `organizationId` and puts it in the WHERE
 * clause (or the composite `id_organizationId` key). There is deliberately no lookup by id alone.
 */

const customerSelect = {
  id: true,
  externalId: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  company: true,
  jobTitle: true,
  status: true,
  source: true,
  metadata: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
  archivedAt: true,
} satisfies Prisma.CustomerSelect;

export type CustomerRecord = Prisma.CustomerGetPayload<{ select: typeof customerSelect }>;

/** Slim projection for table rows: no metadata, notes or activities. */
const listSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  company: true,
  jobTitle: true,
  status: true,
  source: true,
  lastActivityAt: true,
  createdAt: true,
  updatedAt: true,
  tags: {
    orderBy: { tag: { name: "asc" } },
    select: { tag: { select: { id: true, name: true } } },
  },
} satisfies Prisma.CustomerSelect;

type ListRow = Prisma.CustomerGetPayload<{ select: typeof listSelect }>;

export type CustomerListItem = Omit<ListRow, "tags"> & { tags: { id: string; name: string }[] };

export type CreateCustomerData = {
  externalId: string | null;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  jobTitle: string | null;
  source: string | null;
  status: CustomerStatus;
  metadata?: Prisma.InputJsonValue | null;
};

export type UpdateCustomerData = Partial<CreateCustomerData> & { archivedAt?: Date | null };

export const customersRepository = {
  create(organizationId: string, data: CreateCustomerData, db: Db = getDb()) {
    const { metadata, ...rest } = data;
    return db.customer.create({
      data: {
        ...rest,
        organizationId,
        archivedAt: data.status === "ARCHIVED" ? new Date() : null,
        ...(metadata ? { metadata } : {}),
      },
      select: customerSelect,
    });
  },

  findById(organizationId: string, id: string, db: Db = getDb()) {
    return db.customer.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: customerSelect,
    });
  },

  findByEmail(organizationId: string, email: string, db: Db = getDb()) {
    return db.customer.findUnique({
      where: { organizationId_email: { organizationId, email } },
      select: { id: true },
    });
  },

  /** Inbound email routing: the customer with this (lowercase) address in this organization, any status. */
  findByEmailForRouting(organizationId: string, email: string, db: Db = getDb()) {
    return db.customer.findUnique({
      where: { organizationId_email: { organizationId, email } },
      select: { id: true, status: true },
    });
  },

  update(organizationId: string, id: string, data: UpdateCustomerData, db: Db = getDb()) {
    const { metadata, ...rest } = data;
    return db.customer.update({
      where: { id_organizationId: { id, organizationId } },
      data: {
        ...rest,
        ...(metadata !== undefined ? { metadata: metadata ?? Prisma.JsonNull } : {}),
        updatedAt: new Date(),
      },
      select: customerSelect,
    });
  },

  async list(
    organizationId: string,
    query: ListCustomersQuery,
    db: Db = getDb(),
  ): Promise<{ items: CustomerListItem[]; total: number }> {
    const where = buildWhere(organizationId, query);
    const [rows, total] = await Promise.all([
      db.customer.findMany({
        where,
        orderBy: buildOrderBy(query),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: listSelect,
      }),
      db.customer.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({ ...row, tags: row.tags.map((link) => link.tag) })),
      total,
    };
  },
};

function buildWhere(organizationId: string, query: ListCustomersQuery): Prisma.CustomerWhereInput {
  const and: Prisma.CustomerWhereInput[] = [];

  if (query.status?.length) {
    and.push({ status: { in: query.status } });
  } else if (!query.includeArchived) {
    and.push({ status: { not: "ARCHIVED" } });
  }

  // Every whitespace-separated token must match at least one searchable field (AND of ORs), so
  // "ada lovelace" finds firstName=Ada + lastName=Lovelace.
  for (const rawToken of searchTokens(query.q)) {
    const token = escapeLike(rawToken);
    const phoneDigits = rawToken.replace(/\D/g, "");
    and.push({
      OR: [
        { firstName: { contains: token, mode: "insensitive" } },
        { lastName: { contains: token, mode: "insensitive" } },
        { email: { contains: token, mode: "insensitive" } },
        { company: { contains: token, mode: "insensitive" } },
        // Stored phones are digits-only (plus optional "+"), so match on the digits of the token.
        ...(phoneDigits.length >= 3 ? [{ phone: { contains: phoneDigits } }] : []),
      ],
    });
  }

  // Tag filter is AND: a customer must carry every selected tag. Foreign tag ids simply match
  // nothing because customers only link to tags of their own organization.
  for (const tagId of query.tagIds ?? []) {
    and.push({ tags: { some: { tagId, organizationId } } });
  }

  if (query.company) and.push({ company: { equals: query.company, mode: "insensitive" } });
  if (query.source) and.push({ source: { equals: query.source, mode: "insensitive" } });

  if (query.createdFrom || query.createdTo) {
    and.push({
      createdAt: {
        ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
        ...(query.createdTo ? { lte: new Date(query.createdTo) } : {}),
      },
    });
  }

  return { organizationId, AND: and };
}

function buildOrderBy(query: ListCustomersQuery): Prisma.CustomerOrderByWithRelationInput[] {
  const dir = query.order;
  // `id` is a unique tie-breaker so pages never overlap or skip rows when values are equal.
  if (query.sort === "name") {
    return [{ firstName: dir }, { lastName: { sort: dir, nulls: "last" } }, { id: dir }];
  }
  return [{ [query.sort]: dir }, { id: dir }];
}
