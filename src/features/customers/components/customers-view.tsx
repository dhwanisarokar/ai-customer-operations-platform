"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { CustomerListResponse } from "../api/types";
import { useCustomers } from "../hooks/queries";
import { customersHref } from "../list-params";
import type { ListCustomersQuery } from "../schemas";
import { CustomersTable } from "./customers-table";

type Props = {
  query: ListCustomersQuery;
  /** Current URL params (for sort/pagination links). */
  params: Record<string, string>;
  /** Fetched on the server for first paint; TanStack Query owns the data from here on. */
  initialData: CustomerListResponse;
  filtered: boolean;
  canCreate: boolean;
};

/**
 * The customer list. The URL (filters, search, sort, page) is the source of truth for WHICH list is
 * shown; TanStack Query owns the list's data (caching, background refresh, optimistic archive).
 */
export function CustomersView({ query, params, initialData, filtered, canCreate }: Props) {
  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } = useCustomers(
    query,
    { initialData },
  );

  if (isPending) return <CustomersSkeleton />;

  if (!data) {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <Alert variant="destructive">
          <AlertTitle>Unable to load customers</AlertTitle>
          <AlertDescription>{error?.message ?? "Please try again."}</AlertDescription>
        </Alert>
        <Button variant="outline" className="self-start" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (data.total === 0) {
    return filtered ? (
      <EmptyState
        title="No customers match your filters"
        description="Try a different search or clear the filters."
        action={
          <Link href="/dashboard/customers" className={buttonVariants({ variant: "outline" })}>
            Clear filters
          </Link>
        }
      />
    ) : (
      <EmptyState
        title="No customers yet"
        description="Add your first customer to start building their profile and timeline."
        action={
          canCreate ? (
            <Link href="/dashboard/customers/new" className={buttonVariants()}>
              New customer
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {isError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            Could not refresh the list. Showing the last loaded data.
          </AlertDescription>
        </Alert>
      ) : null}
      <div
        aria-busy={isFetching}
        className={cn("transition-opacity", isPlaceholderData && "opacity-60")}
      >
        <CustomersTable
          customers={data.items}
          sort={query.sort}
          order={query.order}
          params={params}
        />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1">
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            totalPages={data.totalPages}
            hrefForPage={(page) => customersHref(params, { page: String(page) })}
          />
        </div>
        <span aria-live="polite" className="text-muted-foreground text-xs">
          {isFetching ? "Updating..." : ""}
        </span>
      </div>
    </div>
  );
}

function CustomersSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading customers">
      {Array.from({ length: 8 }, (_, index) => (
        <Skeleton key={index} className="h-11 w-full" />
      ))}
    </div>
  );
}
