import { NextResponse } from "next/server";
import { createNoteSchema, paginationSchema } from "@/features/customers/schemas";
import { requireOrganizationContext } from "@/server/auth/context";
import { apiHandler, parseJsonBody, parseQuery } from "@/server/http/handler";
import { parseUuidParam } from "@/server/http/params";
import { addNote, listNotes } from "@/server/services/customer-notes";

type Params = { customerId: string };

export const GET = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  const pagination = parseQuery(request, paginationSchema);
  return NextResponse.json(await listNotes(ctx, customerId, pagination));
});

export const POST = apiHandler<Params>(async (request, { params }) => {
  const ctx = await requireOrganizationContext();
  const customerId = parseUuidParam((await params).customerId, "Customer");
  const { content } = await parseJsonBody(request, createNoteSchema);
  return NextResponse.json({ note: await addNote(ctx, customerId, content) }, { status: 201 });
});
