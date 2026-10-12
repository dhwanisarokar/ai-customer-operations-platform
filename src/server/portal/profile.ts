import { transaction } from "@/db/client";
import type { PortalProfileUpdate } from "@/features/portal/schemas";
import { createLogger } from "@/lib/logger";
import { emitDomainEvent } from "@/server/events/bus";
import { NotFoundError } from "@/server/errors";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { customersRepository } from "@/server/repositories/customers";
import type { PortalContext } from "./context";

const log = createLogger("portal");

/** What a customer sees of their own record. No tags, notes, activity, status, source or metadata. */
export type PortalProfile = {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
};

function toProfile(customer: {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}): PortalProfile {
  return {
    firstName: customer.firstName,
    lastName: customer.lastName,
    email: customer.email,
    phone: customer.phone,
    company: customer.company,
  };
}

export async function getPortalProfile(ctx: PortalContext): Promise<PortalProfile> {
  const customer = await customersRepository.findById(ctx.organization.id, ctx.customer.id);
  if (!customer) throw new NotFoundError("Profile not found");
  return toProfile(customer);
}

/**
 * Updates the permitted fields (first name, last name, phone) of the linked customer: the record is the
 * one in the server-side context, never an id from the request. Email is not updatable here; the
 * strict schema rejects it. The change is recorded on the customer's timeline (actor CUSTOMER) and emits the
 * normal `customer.updated` domain event (so automations see it).
 */
export async function updatePortalProfile(
  ctx: PortalContext,
  input: PortalProfileUpdate,
): Promise<PortalProfile> {
  const { organization, customer } = ctx;
  let changedFields: string[] = [];

  const updated = await transaction(async (tx) => {
    const current = await customersRepository.findById(organization.id, customer.id, tx);
    if (!current) throw new NotFoundError("Profile not found");
    const data: Partial<Record<"firstName" | "lastName" | "phone", string | null>> = {};
    for (const key of ["firstName", "lastName", "phone"] as const) {
      if (input[key] !== undefined && input[key] !== current[key]) data[key] = input[key] ?? null;
    }
    changedFields = Object.keys(data);
    if (changedFields.length === 0) return current;

    const next = await customersRepository.update(
      organization.id,
      customer.id,
      data as { firstName?: string; lastName?: string | null; phone?: string | null },
      tx,
    );
    await customerActivitiesRepository.record(
      organization.id,
      customer.id,
      {
        type: "CUSTOMER_UPDATED",
        title: "Profile updated by the customer",
        description: `Changed ${changedFields.join(", ")}`,
        actorType: "CUSTOMER",
        actorId: customer.id,
      },
      tx,
    );
    return next;
  });

  if (changedFields.length > 0) {
    log.info(
      { organizationId: organization.id, customerId: customer.id, fields: changedFields },
      "portal profile updated",
    );
    await emitDomainEvent({
      organizationId: organization.id,
      actorUserId: null,
      type: "customer.updated",
      data: {
        customerId: customer.id,
        status: updated.status,
        company: updated.company ?? null,
        changedFields,
      },
    });
  }
  return toProfile(updated);
}
