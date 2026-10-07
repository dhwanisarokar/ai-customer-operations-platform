import Link from "next/link";
import { cn } from "@/lib/utils";
import { INBOX_VIEWS, type InboxViewId } from "../inbox-params";
import { inboxHref } from "../inbox-params";

/** View links (Open, Pending, Assigned to me, ...). Each view maps to a server-side filter. */
export function InboxSidebar({
  view,
  q,
  customer,
}: {
  view: InboxViewId;
  q: string;
  customer?: string | null;
}) {
  return (
    <nav aria-label="Inbox views" className="flex flex-wrap gap-1 lg:flex-col lg:gap-0.5">
      {INBOX_VIEWS.map((item) => {
        const active = item.id === view;
        return (
          <Link
            key={item.id}
            href={inboxHref({ q, customer }, { view: item.id })}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-md px-3 py-1.5 text-sm transition-colors",
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
