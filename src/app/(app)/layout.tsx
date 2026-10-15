import { ClerkProvider } from "@clerk/nextjs";

/**
 * The authenticated application (home, sign-in/up, dashboard). Clerk is scoped to this route group on
 * purpose: the public chat widget (/widget) is a sibling and must never load Clerk, because it runs in
 * visitors' browsers inside third-party iframes where Clerk's development handshake cannot work.
 *
 * `dynamic` makes Clerk render its script tags with the per-request nonce from the Content-Security-Policy set in
 * src/proxy.ts. Without it the policy (nonce + strict-dynamic) blocks Clerk's own scripts. Every page in this group
 * already renders per request, so nothing becomes slower.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider dynamic>{children}</ClerkProvider>;
}
