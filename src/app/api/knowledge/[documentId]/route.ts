import { NextResponse } from "next/server";
import { updateDocumentSchema } from "@/features/knowledge/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { deleteDocument, getDocument, updateDocument } from "@/server/services/knowledge";

type Params = { documentId: string };

export const GET = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).documentId, "Document");
  return NextResponse.json({ document: await getDocument(ctx, id) });
});

/** Title, description, content. Status changes use the publish/unpublish/archive endpoints. */
export const PATCH = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).documentId, "Document");
  const input = await parseJsonBody(request, updateDocumentSchema);
  return NextResponse.json({ document: await updateDocument(ctx, id, input) });
});

export const DELETE = apiHandler<Params>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  await deleteDocument(ctx, parseUuidParam((await params).documentId, "Document"));
  return new NextResponse(null, { status: 204 });
});
