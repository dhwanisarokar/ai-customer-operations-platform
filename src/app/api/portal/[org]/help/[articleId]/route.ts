import { NextResponse } from "next/server";
import { parseUuidParam } from "@/server/http/params";
import { getHelpArticle } from "@/server/portal/help";
import { limitCustomer, portalHandler, PORTAL_LIMITS } from "@/server/portal/route";

export const GET = portalHandler<{ org: string; articleId: string }>(
  async (_request, ctx, params) => {
    await limitCustomer(ctx, "read", PORTAL_LIMITS.reads);
    const id = parseUuidParam(params.articleId, "Article");
    return NextResponse.json({ article: await getHelpArticle(ctx, id) });
  },
);
