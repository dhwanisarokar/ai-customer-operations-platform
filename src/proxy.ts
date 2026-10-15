import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { WIDGET_PAGE_PATTERN, appCspDirectives, generateNonce, widgetCsp } from "@/lib/csp";

// Only UI pages are gated here (the staff dashboard and the customer portal). API routes authenticate themselves and answer 401 JSON rather
// than redirecting, and every handler re-checks identity and tenant membership server-side.
const isProtectedPage = createRouteMatcher(["/dashboard(.*)", "/portal(.*)"]);

/** `CSP_REPORT_ONLY=true` makes the browser REPORT policy violations instead of blocking them (a safe first deployment). */
const reportOnly = () => process.env.CSP_REPORT_ONLY === "true";

/** The Clerk-managed app: strict nonce CSP built by Clerk plus our own directives (see src/lib/csp.ts). */
export function appClerkOptions() {
  return {
    contentSecurityPolicy: {
      strict: true,
      reportOnly: reportOnly(),
      directives: appCspDirectives(process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY),
    },
  };
}

const clerk = clerkMiddleware(async (auth, request) => {
  if (isProtectedPage(request)) await auth.protect();
}, appClerkOptions);

/**
 * The public widget page: no Clerk (it runs inside visitors' browsers in third-party iframes, where Clerk's development
 * handshake redirects loop), but it still gets a per-request nonce policy. Next.js reads the nonce from the request's
 * Content-Security-Policy header and applies it to its own scripts.
 */
function widgetPage(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const policy = widgetCsp(nonce, { development: process.env.NODE_ENV === "development" });
  const name = reportOnly() ? "Content-Security-Policy-Report-Only" : "Content-Security-Policy";
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(name, policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(name, policy);
  return response;
}

export default function proxy(request: NextRequest, event: NextFetchEvent) {
  if (WIDGET_PAGE_PATTERN.test(request.nextUrl.pathname)) return widgetPage(request);
  return clerk(request, event);
}

/**
 * Paths the proxy does not run for at all: the email provider's inbound webhook (a server-to-server call that carries no
 * browser session and authenticates itself with the provider's signature) and the widget's visitor API
 * (`/api/widget/`, bearer-token authenticated JSON and server-sent events). The widget PAGE (`/widget/`) is matched, but
 * `proxy` above sends it past Clerk. Internal routes (including /api/widget-settings, which is staff-only) are NOT excluded:
 * only the exact `/api/widget/` prefix.
 */
export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|api/widget/|api/email/inbound|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api(?!/widget/|/email/inbound)|trpc)(.*)",
  ],
};
