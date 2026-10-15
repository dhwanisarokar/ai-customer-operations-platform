import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOrganizationContext } from "@/server/auth/context";
import { ATTENTION, ATTENTION_CATEGORIES, listAttention } from "@/server/email/outbound-ops";
import { apiHandler, parseQuery } from "@/server/http/handler";

const querySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(ATTENTION.maxPageSize).default(20),
    category: z.enum(ATTENTION_CATEGORIES as unknown as [string, ...string[]]).optional(),
  })
  .strict();

/**
 * Outbound email that needs attention, for the CALLER'S organization only (`manage_email`: admins and owners). Overdue,
 * stalled, unknown and failed sends from persisted state; masked recipients; no bodies, subjects, provider ids,
 * credentials, raw errors or lease details. There is no platform-wide variant (no platform-operator role exists).
 */
export const GET = apiHandler(async (request) => {
  const ctx = await requireOrganizationContext();
  const query = parseQuery(request, querySchema);
  return NextResponse.json(
    await listAttention(ctx, { ...query, category: query.category as never }),
  );
});
