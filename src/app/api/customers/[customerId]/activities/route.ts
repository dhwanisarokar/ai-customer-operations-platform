import { NextResponse } from "next/server";
import { paginationSchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseQuery } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { listActivities } from "@/server/services/customer-activities";

export const GET = apiHandler<{ customerId: string }>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  const pagination = parseQuery(request, paginationSchema);
  return NextResponse.json(await listActivities(ctx, customerId, pagination));
});
