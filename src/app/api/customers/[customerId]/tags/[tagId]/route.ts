import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { removeTagFromCustomer } from "@/server/services/customer-tags";

type Params = { customerId: string; tagId: string };

export const DELETE = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const { customerId, tagId } = await params;
  await removeTagFromCustomer(
    ctx,
    parseUuidParam(customerId, "Customer"),
    parseUuidParam(tagId, "Tag"),
  );
  return new NextResponse(null, { status: 204 });
});
