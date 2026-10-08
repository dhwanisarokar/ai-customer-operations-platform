"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export const DASHBOARD_LINKS = [
  { href: "/dashboard", label: "Overview", exact: true },
  { href: "/dashboard/inbox", label: "Inbox", exact: false },
  { href: "/dashboard/customers", label: "Customers", exact: false },
  { href: "/dashboard/knowledge", label: "Knowledge", exact: false },
  { href: "/dashboard/automations", label: "Automations", exact: false },
] as const;

export function isActiveLink(pathname: string, href: string, exact: boolean) {
  return exact ? pathname === href : pathname.startsWith(href);
}

export function DashboardNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex items-center gap-1">
      {DASHBOARD_LINKS.map(({ href, label, exact }) => {
        const active = isActiveLink(pathname, href, exact);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
