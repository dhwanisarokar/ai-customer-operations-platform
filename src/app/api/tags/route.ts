import { NextResponse } from "next/server";
import { createTagSchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { createTag, listTags } from "@/server/services/customer-tags";

export const GET = apiHandler(async () => {
  const ctx = await requireOrganizationContext();
  return NextResponse.json({ tags: await listTags(ctx) });
});

export const POST = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, createTagSchema);
  return NextResponse.json({ tag: await createTag(ctx, input) }, { status: 201 });
});
