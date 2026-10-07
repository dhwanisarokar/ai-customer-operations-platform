import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { archiveDocument } from "@/server/services/knowledge";

export const POST = apiHandler<{ documentId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).documentId, "Document");
  return NextResponse.json({ document: await archiveDocument(ctx, id) });
});
