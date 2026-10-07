import { transaction } from "@/db/client";
import type { Pagination } from "@/features/customers/schemas";
import type { OrganizationContext } from "@/server/auth/context";
import { toPage, toSkipTake } from "@/server/http/pagination";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { customerNotesRepository } from "@/server/repositories/customer-notes";
import { requireCustomer, userActor } from "./customers";

const PREVIEW_LENGTH = 140;

/** The author is always the authenticated member; it cannot be supplied by the client. */
export async function addNote(ctx: OrganizationContext, customerId: string, content: string) {
  ctx.require("add_customer_notes");
  const organizationId = ctx.organization.id;

  return transaction(async (tx) => {
    await requireCustomer(ctx, customerId, tx);
    const note = await customerNotesRepository.create(
      organizationId,
      customerId,
      ctx.user.id,
      content,
      tx,
    );
    await customerActivitiesRepository.record(
      organizationId,
      customerId,
      {
        type: "NOTE_ADDED",
        title: "Note added",
        description: preview(content),
        metadata: { noteId: note.id },
        ...userActor(ctx),
      },
      tx,
    );
    return note;
  });
}

export async function listNotes(
  ctx: OrganizationContext,
  customerId: string,
  pagination: Pagination,
) {
  ctx.require("view_customers");
  await requireCustomer(ctx, customerId);
  const { items, total } = await customerNotesRepository.list(
    ctx.organization.id,
    customerId,
    toSkipTake(pagination),
  );
  return toPage(items, total, pagination);
}

function preview(content: string): string {
  return content.length > PREVIEW_LENGTH ? `${content.slice(0, PREVIEW_LENGTH - 1)}…` : content;
}
