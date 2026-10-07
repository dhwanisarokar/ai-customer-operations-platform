import { NextResponse } from "next/server";
import { createCustomerSchema, listCustomersQuerySchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody, parseQuery } from "@/server/http/handler";
import { createCustomer, listCustomers } from "@/server/services/customers";

export const GET = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const query = parseQuery(request, listCustomersQuerySchema);
  return NextResponse.json(await listCustomers(ctx, query));
});

export const POST = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, createCustomerSchema);
  return NextResponse.json({ customer: await createCustomer(ctx, input) }, { status: 201 });
});
