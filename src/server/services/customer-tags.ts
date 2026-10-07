import { transaction } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import type { AssignTagInput } from "@/features/customers/schemas";
import { normalizeTagName } from "@/features/customers/normalize";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { tagsRepository } from "@/server/repositories/tags";
import { requireCustomer, userActor } from "./customers";

const log = createLogger("customer-tags");

// ---- organization tag catalogue -------------------------------------------------------------

export function listTags(ctx: OrganizationContext) {
  ctx.require("view_customers");
  return tagsRepository.list(ctx.organization.id);
}

export async function createTag(ctx: OrganizationContext, input: { name: string }) {
  ctx.require("tag_customers");
  try {
    return await tagsRepository.create(ctx.organization.id, normalizeTagName(input.name));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("A tag with this name already exists");
    throw error;
  }
}

export async function renameTag(ctx: OrganizationContext, tagId: string, input: { name: string }) {
  ctx.require("manage_tags");
  if (!(await tagsRepository.findById(ctx.organization.id, tagId))) {
    throw new NotFoundError("Tag not found");
  }
  try {
    return await tagsRepository.rename(ctx.organization.id, tagId, normalizeTagName(input.name));
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("A tag with this name already exists");
    throw error;
  }
}

/** Deleting a tag detaches it from every customer. Per-customer timeline entries are not written. */
export async function deleteTag(ctx: OrganizationContext, tagId: string) {
  ctx.require("manage_tags");
  const deleted = await tagsRepository.delete(ctx.organization.id, tagId);
  if (!deleted) throw new NotFoundError("Tag not found");
  log.info({ organizationId: ctx.organization.id, tagId, actorId: ctx.user.id }, "tag deleted");
}

// ---- tags on a customer ---------------------------------------------------------------------

export async function listCustomerTags(ctx: OrganizationContext, customerId: string) {
  ctx.require("view_customers");
  await requireCustomer(ctx, customerId);
  return tagsRepository.listForCustomer(ctx.organization.id, customerId);
}

/**
 * Assigns a tag by id, or find-or-creates one by name. Tag and customer are both resolved inside
 * the caller's organization, so a foreign tag id is a 404; the composite foreign keys on
 * customer_tags would reject it even if the application check were missing.
 */
export async function addTagToCustomer(
  ctx: OrganizationContext,
  customerId: string,
  input: AssignTagInput,
) {
  ctx.require("tag_customers");
  const organizationId = ctx.organization.id;

  try {
    return await transaction(async (tx) => {
      await requireCustomer(ctx, customerId, tx);

      const tag =
        "tagId" in input
          ? await tagsRepository.findById(organizationId, input.tagId, tx)
          : await tagsRepository.findOrCreate(organizationId, normalizeTagName(input.name), tx);
      if (!tag) throw new NotFoundError("Tag not found");

      await tagsRepository.assign(organizationId, customerId, tag.id, tx);
      await customerActivitiesRepository.record(
        organizationId,
        customerId,
        {
          type: "TAG_ADDED",
          title: `Tag "${tag.name}" added`,
          metadata: { tagId: tag.id, tagName: tag.name },
          ...userActor(ctx),
        },
        tx,
      );
      return tag;
    });
  } catch (error) {
    if (isUniqueViolation(error))
      throw new ConflictError("Tag is already assigned to this customer");
    throw error;
  }
}

export async function removeTagFromCustomer(
  ctx: OrganizationContext,
  customerId: string,
  tagId: string,
) {
  ctx.require("tag_customers");
  const organizationId = ctx.organization.id;

  await transaction(async (tx) => {
    await requireCustomer(ctx, customerId, tx);
    const tag = await tagsRepository.findById(organizationId, tagId, tx);
    if (!tag) throw new NotFoundError("Tag not found");
    if (!(await tagsRepository.unassign(organizationId, customerId, tagId, tx))) {
      throw new NotFoundError("Tag is not assigned to this customer");
    }
    await customerActivitiesRepository.record(
      organizationId,
      customerId,
      {
        type: "TAG_REMOVED",
        title: `Tag "${tag.name}" removed`,
        metadata: { tagId: tag.id, tagName: tag.name },
        ...userActor(ctx),
      },
      tx,
    );
  });
}
