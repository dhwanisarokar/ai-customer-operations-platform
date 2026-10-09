import { ClerkProvider } from "@clerk/nextjs";

/**
 * The authenticated application (home, sign-in/up, dashboard). Clerk is scoped to this route group on
 * purpose: the public chat widget (/widget) is a sibling and must never load Clerk, because it runs in
 * visitors' browsers inside third-party iframes where Clerk's development handshake cannot work.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <ClerkProvider>{children}</ClerkProvider>;
}
