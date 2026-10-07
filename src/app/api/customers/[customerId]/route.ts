import { NextResponse } from "next/server";
import { updateCustomerSchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { archiveCustomer, getCustomer360, updateCustomer } from "@/server/services/customers";

type Params = { customerId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  return NextResponse.json(await getCustomer360(ctx, customerId));
});

export const PATCH = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  const input = await parseJsonBody(request, updateCustomerSchema);
  return NextResponse.json({ customer: await updateCustomer(ctx, customerId, input) });
});

/** Archives (soft-deletes) the customer; nothing is physically removed. */
export const DELETE = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  await archiveCustomer(ctx, customerId);
  return new NextResponse(null, { status: 204 });
});
