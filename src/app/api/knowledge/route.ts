import { NextResponse } from "next/server";
import { createDocumentSchema, listDocumentsQuerySchema } from "@/features/knowledge/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody, parseQuery } from "@/server/http/handler";
import { createDocument, listDocuments } from "@/server/services/knowledge";

export const GET = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const query = parseQuery(request, listDocumentsQuerySchema);
  return NextResponse.json(await listDocuments(ctx, query));
});

export const POST = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const input = await parseJsonBody(request, createDocumentSchema);
  return NextResponse.json({ document: await createDocument(ctx, input) }, { status: 201 });
});
