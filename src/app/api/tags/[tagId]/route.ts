import { NextResponse } from "next/server";
import { updateTagSchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { deleteTag, renameTag } from "@/server/services/customer-tags";

type Params = { tagId: string };

export const PATCH = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const tagId = parseUuidParam((await params).tagId, "Tag");
  const input = await parseJsonBody(request, updateTagSchema);
  return NextResponse.json({ tag: await renameTag(ctx, tagId, input) });
});

export const DELETE = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  await deleteTag(ctx, parseUuidParam((await params).tagId, "Tag"));
  return new NextResponse(null, { status: 204 });
});
