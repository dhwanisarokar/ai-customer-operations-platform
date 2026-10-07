import Link from "next/link";
import { cn } from "@/lib/utils";
import { INBOX_VIEWS, type InboxViewId } from "../inbox-params";
import { inboxHref } from "../inbox-params";

/** View links (Open, Pending, Assigned to me, ...). Each view maps to a server-side filter. */
export function InboxSidebar({
  view,
  q,
  customer,
  compact = false,
}: {
  view: InboxViewId;
  q: string;
  customer?: string | null;
  /** One horizontally scrollable row (tablet/phone) instead of the vertical list. */
  compact?: boolean;
}) {
  return (
    <nav
      aria-label="Inbox views"
      className={cn("flex gap-1", compact ? "w-max" : "flex-col gap-0.5")}
    >
      {INBOX_VIEWS.map((item) => {
        const active = item.id === view;
        return (
          <Link
            key={item.id}
            href={inboxHref({ q, customer }, { view: item.id })}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors",
              active
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
