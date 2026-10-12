import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Only UI pages are gated here (the staff dashboard and the customer portal). API routes authenticate themselves and answer 401 JSON rather
// than redirecting, and every handler re-checks identity and tenant membership server-side.
const isProtectedPage = createRouteMatcher(["/dashboard(.*)", "/portal(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedPage(request)) await auth.protect();
});

/**
 * Paths Clerk must not touch: the public chat widget page and its visitor API. They authenticate with
 * a widget key and a visitor session instead, and run in visitors' browsers inside third-party
 * iframes, where Clerk's development handshake redirects loop. Internal routes (including
 * /api/widget-settings, which is staff-only) are NOT excluded: only the exact `/widget/` and
 * `/api/widget/` prefixes.
 */
export const config = {
  matcher: [
    // Skip Next.js internals, the public widget and static files.
    "/((?!_next|widget/|api/widget/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api(?!/widget/)|trpc)(.*)",
  ],
};
