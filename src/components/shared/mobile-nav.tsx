"use client";

import { SignOutButton } from "@clerk/nextjs";
import { MenuIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { DASHBOARD_LINKS, isActiveLink } from "./dashboard-nav";

/**
 * Compact navigation for small screens: a menu button that opens a panel under the header with the
 * same links (and Sign out). Desktop keeps the inline nav; this is hidden from md up.
 */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const Icon = open ? XIcon : MenuIcon;

  return (
    <div className="md:hidden" onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        onClick={() => setOpen((value) => !value)}
      >
        <Icon aria-hidden="true" />
      </Button>
      {open ? (
        <nav
          id="mobile-nav-panel"
          aria-label="Main"
          className="border-border bg-card absolute inset-x-0 top-full z-40 flex flex-col gap-1 border-b p-3 shadow-lg"
        >
          {DASHBOARD_LINKS.map(({ href, label, exact }) => {
            const active = isActiveLink(pathname, href, exact);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={cn(
                  "rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </Link>
            );
          })}
          <SignOutButton redirectUrl="/">
            <Button variant="outline" size="sm" className="mt-2 self-start">
              Sign out
            </Button>
          </SignOutButton>
        </nav>
      ) : null}
    </div>
  );
}
