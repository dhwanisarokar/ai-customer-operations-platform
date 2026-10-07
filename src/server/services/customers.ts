import { isUniqueViolation } from "@/db/errors";
import { transaction } from "@/db/client";
import type {
  CreateCustomerInput,
  ListCustomersQuery,
  UpdateCustomerInput,
} from "@/features/customers/schemas";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { toPage, type Page } from "@/server/http/pagination";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { customerNotesRepository } from "@/server/repositories/customer-notes";
import {
  customersRepository,
  type CustomerListItem,
  type CustomerRecord,
  type UpdateCustomerData,
} from "@/server/repositories/customers";
import { tagsRepository } from "@/server/repositories/tags";
import type { Prisma } from "@/generated/prisma/client";

const log = createLogger("customers");

const RECENT_ACTIVITIES = 20;
const RECENT_NOTES = 10;

/** The authenticated user as the actor of timeline entries. */
export function userActor(ctx: OrganizationContext) {
  return { actorType: "USER" as const, actorId: ctx.user.id };
}

/**
 * Resolves a customer inside the caller's organization or throws 404. A customer id that exists
 * in another organization is indistinguishable from one that does not exist.
 */
export async function requireCustomer(
  ctx: OrganizationContext,
  customerId: string,
  db?: Parameters<typeof customersRepository.findById>[2],
): Promise<CustomerRecord> {
  const customer = await customersRepository.findById(ctx.organization.id, customerId, db);
  if (!customer) throw new NotFoundError("Customer not found");
  return customer;
}

export async function createCustomer(ctx: OrganizationContext, input: CreateCustomerInput) {
  ctx.require("create_customers");
  const organizationId = ctx.organization.id;

  try {
    // Customer and its CUSTOMER_CREATED activity commit together or not at all.
    const customer = await transaction(async (tx) => {
      const created = await customersRepository.create(
        organizationId,
        { ...input, metadata: input.metadata as Prisma.InputJsonValue | null | undefined },
        tx,
      );
      await customerActivitiesRepository.record(
        organizationId,
        created.id,
        {
          type: "CUSTOMER_CREATED",
          title: "Customer created",
          metadata: { source: created.source },
          ...userActor(ctx),
        },
        tx,
      );
      return created;
    });
    log.info({ organizationId, customerId: customer.id, actorId: ctx.user.id }, "customer created");
    return customer;
  } catch (error) {
    throw await translateConflict(error, organizationId, input.email);
  }
}

export async function updateCustomer(
  ctx: OrganizationContext,
  customerId: string,
  input: UpdateCustomerInput,
) {
  ctx.require("update_customers");
  const organizationId = ctx.organization.id;

  try {
    return await transaction(async (tx) => {
      const current = await requireCustomer(ctx, customerId, tx);
      const changes = diffCustomer(current, input);
      if (Object.keys(changes).length === 0) return current;

      const data: UpdateCustomerData = {};
      for (const key of Object.keys(changes) as (keyof UpdateCustomerInput)[]) {
        (data as Record<string, unknown>)[key] = input[key];
      }
      // Setting an active/inactive status on an archived customer restores it.
      if (current.status === "ARCHIVED" && input.status) data.archivedAt = null;

      const updated = await customersRepository.update(organizationId, customerId, data, tx);
      await customerActivitiesRepository.record(
        organizationId,
        customerId,
        {
          type: "CUSTOMER_UPDATED",
          title: "Customer updated",
          description: `Changed ${Object.keys(changes).join(", ")}`,
          metadata: { changes } as Prisma.InputJsonValue,
          ...userActor(ctx),
        },
        tx,
      );
      log.info(
        { organizationId, customerId, actorId: ctx.user.id, fields: Object.keys(changes) },
        "customer updated",
      );
      return updated;
    });
  } catch (error) {
    throw await translateConflict(error, organizationId, input.email, customerId);
  }
}

/** Soft delete: sets status ARCHIVED + archivedAt. History, notes and tags are preserved. */
export async function archiveCustomer(ctx: OrganizationContext, customerId: string) {
  ctx.require("archive_customers");
  const organizationId = ctx.organization.id;

  await transaction(async (tx) => {
    const current = await requireCustomer(ctx, customerId, tx);
    if (current.status === "ARCHIVED") return; // idempotent: no second timeline entry
    await customersRepository.update(
      organizationId,
      customerId,
      { status: "ARCHIVED", archivedAt: new Date() },
      tx,
    );
    await customerActivitiesRepository.record(
      organizationId,
      customerId,
      { type: "CUSTOMER_ARCHIVED", title: "Customer archived", ...userActor(ctx) },
      tx,
    );
    log.info({ organizationId, customerId, actorId: ctx.user.id }, "customer archived");
  });
}

export async function listCustomers(
  ctx: OrganizationContext,
  query: ListCustomersQuery,
): Promise<Page<CustomerListItem>> {
  ctx.require("view_customers");
  const { items, total } = await customersRepository.list(ctx.organization.id, query);
  return toPage(items, total, query);
}

/**
 * Customer 360: everything needed to understand one customer at a glance. Also the intended
 * input for the future AI agent, so the shape is kept stable and free of internal ids.
 */
export async function getCustomer360(ctx: OrganizationContext, customerId: string) {
  ctx.require("view_customers");
  const organizationId = ctx.organization.id;
  const customer = await requireCustomer(ctx, customerId);

  const [tags, activities, notes] = await Promise.all([
    tagsRepository.listForCustomer(organizationId, customerId),
    customerActivitiesRepository.list(organizationId, customerId, {
      skip: 0,
      take: RECENT_ACTIVITIES,
    }),
    customerNotesRepository.list(organizationId, customerId, { skip: 0, take: RECENT_NOTES }),
  ]);

  return {
    customer,
    tags,
    recentActivities: activities.items,
    notes: notes.items,
    counts: { activities: activities.total, notes: notes.total },
  };
}

// ---------------------------------------------------------------------------------------------

const TRACKED_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "company",
  "jobTitle",
  "source",
  "externalId",
  "status",
  "metadata",
] as const;

/** Fields whose submitted value differs from the stored one, as { field: { from, to } }. */
function diffCustomer(current: CustomerRecord, input: UpdateCustomerInput) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of TRACKED_FIELDS) {
    if (input[field] === undefined) continue;
    const from = current[field] ?? null;
    const to = input[field] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to)) changes[field] = { from, to };
  }
  return changes;
}

/**
 * Turns a unique-constraint failure into a precise 409. The lookup runs outside the failed
 * transaction (PostgreSQL aborts a transaction after an error).
 */
async function translateConflict(
  error: unknown,
  organizationId: string,
  email: string | null | undefined,
  selfId?: string,
): Promise<unknown> {
  if (!isUniqueViolation(error)) return error;
  if (email) {
    const existing = await customersRepository.findByEmail(organizationId, email);
    if (existing && existing.id !== selfId) {
      return new ConflictError("A customer with this email already exists");
    }
  }
  return new ConflictError("A customer with this external id already exists");
}
