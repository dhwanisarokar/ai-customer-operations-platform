import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Only UI pages are gated here. API routes authenticate themselves and answer 401 JSON rather
// than redirecting, and every handler re-checks identity and tenant membership server-side.
const isProtectedPage = createRouteMatcher(["/dashboard(.*)"]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedPage(request)) await auth.protect();
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
