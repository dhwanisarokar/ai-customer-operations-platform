import type { Pagination } from "@/features/customers/schemas";
import type { OrganizationContext } from "@/server/auth/context";
import { toPage, toSkipTake } from "@/server/http/pagination";
import { customerActivitiesRepository } from "@/server/repositories/customer-activities";
import { requireCustomer } from "./customers";

export async function listActivities(
  ctx: OrganizationContext,
  customerId: string,
  pagination: Pagination,
) {
  ctx.require("view_customers");
  await requireCustomer(ctx, customerId);
  const { items, total } = await customerActivitiesRepository.list(
    ctx.organization.id,
    customerId,
    toSkipTake(pagination),
  );
  return toPage(items, total, pagination);
}
