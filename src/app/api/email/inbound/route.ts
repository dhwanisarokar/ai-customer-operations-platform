import { NextResponse } from "next/server";
import {
  handleInboundWebhook,
  MAX_WEBHOOK_BODY_BYTES,
  readBodyWithLimit,
} from "@/server/email/inbound-webhook";
import { apiHandler } from "@/server/http/handler";
import { metrics } from "@/server/observability/metrics";

/**
 * Public endpoint the email provider posts notifications to. It carries no session: the provider adapter
 * authenticates every request (signature + freshness) before anything else happens, and the route is
 * excluded from the Clerk middleware like the widget API (see src/proxy.ts). The raw body is passed on
 * untouched because signatures are computed over the exact bytes received. The size limit is enforced while
 * reading, so an unauthenticated caller cannot make the server buffer an arbitrarily large body.
 */
export const POST = apiHandler(async (request) => {
  const rawBody = await readBodyWithLimit(request, MAX_WEBHOOK_BODY_BYTES);
  if (rawBody === null) {
    metrics.increment("email_webhook_rejected_total", { reason: "too_large" });
    return NextResponse.json({ status: "too_large" }, { status: 413 });
  }
  const headers = Object.fromEntries(
    [...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
  );
  const result = await handleInboundWebhook({ headers, rawBody });
  return NextResponse.json(result.body, { status: result.status });
});
