import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type PaginationProps = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** Builds the URL for a page number so filters/sorting are preserved. */
  hrefForPage: (page: number) => string;
};

export function Pagination({ page, pageSize, total, totalPages, hrefForPage }: PaginationProps) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <nav aria-label="Pagination" className="flex items-center justify-between gap-4 text-sm">
      <p className="text-muted-foreground">
        {from}&ndash;{to} of {total}
      </p>
      <div className="flex items-center gap-2">
        <PageLink href={page > 1 ? hrefForPage(page - 1) : null} label="Previous" />
        <span className="text-muted-foreground px-1">
          Page {page} of {totalPages}
        </span>
        <PageLink href={page < totalPages ? hrefForPage(page + 1) : null} label="Next" />
      </div>
    </nav>
  );
}

function PageLink({ href, label }: { href: string | null; label: string }) {
  const classes = buttonVariants({ variant: "outline", size: "sm" });
  if (!href) {
    return (
      <span aria-disabled="true" className={cn(classes, "pointer-events-none opacity-50")}>
        {label}
      </span>
    );
  }
  return (
    <Link href={href} className={classes}>
      {label}
    </Link>
  );
}
