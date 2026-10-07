import { NextResponse } from "next/server";
import { assignTagSchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { addTagToCustomer, listCustomerTags } from "@/server/services/customer-tags";

type Params = { customerId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  return NextResponse.json({ tags: await listCustomerTags(ctx, customerId) });
});

export const POST = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  const input = await parseJsonBody(request, assignTagSchema);
  const tag = await addTagToCustomer(ctx, customerId, input);
  return NextResponse.json({ tag }, { status: 201 });
});
