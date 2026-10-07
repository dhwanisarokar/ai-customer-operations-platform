import { NextResponse } from "next/server";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { unpublishDocument } from "@/server/services/knowledge";

/** Back to draft (also restores an archived document). Removes its embeddings. */
export const POST = apiHandler<{ documentId: string }>(async (_request, { params }) => {
  const ctx = await requireOrganizationContext();
  const id = parseUuidParam((await params).documentId, "Document");
  return NextResponse.json({ document: await unpublishDocument(ctx, id) });
});
