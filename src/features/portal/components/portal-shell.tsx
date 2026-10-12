"use client";

import { SignOutButton } from "@clerk/nextjs";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { usePortalInfo } from "../portal-context";

/**
 * The customer-facing frame: the organization's name and the portal navigation. No staff navigation,
 * no dashboard links. Signing out ends the Clerk session; the portal API then answers 401.
 */
export function PortalShell({ children }: { children: React.ReactNode }) {
  const { slug, name } = usePortalInfo();
  const pathname = usePathname();
  const base = `/portal/${slug}`;
  const links = [
    { href: base, label: "Home", exact: true },
    { href: `${base}/conversations`, label: "My conversations", exact: false },
    { href: `${base}/help`, label: "Help center", exact: false },
    { href: `${base}/profile`, label: "Profile", exact: false },
  ];
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-border bg-card border-b">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-3 px-6 py-3">
          <Link href={base} className="text-base font-semibold tracking-tight">
            {name}
          </Link>
          <nav aria-label="Portal" className="flex flex-wrap items-center gap-1">
            {links.map((link) => {
              const active = link.exact ? pathname === link.href : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    active
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {link.label}
                </Link>
              );
            })}
            <SignOutButton redirectUrl={base}>
              <Button variant="outline" size="sm" className="ml-2">
                Sign out
              </Button>
            </SignOutButton>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-8">{children}</main>
    </div>
  );
}
