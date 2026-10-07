import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { CustomerFilters } from "@/features/customers/components/customer-filters";
import { CustomersTable } from "@/features/customers/components/customers-table";
import {
  customersHref,
  flattenSearchParams,
  parseListParams,
  type RawSearchParams,
} from "@/features/customers/list-params";
import { requirePageContext } from "@/server/auth/page-context";
import { listTags } from "@/server/services/customer-tags";
import { listCustomers } from "@/server/services/customers";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const ctx = await requirePageContext();
  const params = flattenSearchParams(await searchParams);
  const { query, invalid } = parseListParams(params);

  const [result, tags] = await Promise.all([listCustomers(ctx, query), listTags(ctx)]);
  const filtered = Boolean(
    query.q ||
    query.status ||
    query.tagIds ||
    query.company ||
    query.source ||
    query.createdFrom ||
    query.createdTo,
  );

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Customers</h1>
          <p className="text-muted-foreground text-sm">{ctx.organization.name}</p>
        </div>
        {ctx.can("create_customers") ? (
          <Link href="/dashboard/customers/new" className={buttonVariants()}>
            New customer
          </Link>
        ) : null}
      </div>

      {invalid ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Some filters were invalid and have been reset.</AlertDescription>
        </Alert>
      ) : null}

      <CustomerFilters params={params} tags={tags} />

      {result.total === 0 ? (
        filtered ? (
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
              ctx.can("create_customers") ? (
                <Link href="/dashboard/customers/new" className={buttonVariants()}>
                  New customer
                </Link>
              ) : undefined
            }
          />
        )
      ) : (
        <>
          <CustomersTable
            customers={result.items}
            sort={query.sort}
            order={query.order}
            params={params}
          />
          <Pagination
            page={result.page}
            pageSize={result.pageSize}
            total={result.total}
            totalPages={result.totalPages}
            hrefForPage={(page) => customersHref(params, { page: String(page) })}
          />
        </>
      )}
    </main>
  );
}
