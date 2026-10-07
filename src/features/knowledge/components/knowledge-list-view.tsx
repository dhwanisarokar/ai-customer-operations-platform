"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { KnowledgeListResponse } from "../api/types";
import { useKnowledgeDocuments } from "../hooks/queries";
import { knowledgeHref } from "../list-params";
import type { ListDocumentsQuery } from "../schemas";
import { KnowledgeTable } from "./knowledge-table";

type Props = {
  query: ListDocumentsQuery;
  params: Record<string, string>;
  initialData: KnowledgeListResponse;
  filtered: boolean;
  canCreate: boolean;
};

/** The knowledge list: the URL picks the page/filter, TanStack Query owns the data. */
export function KnowledgeListView({ query, params, initialData, filtered, canCreate }: Props) {
  const { data, isPending, error, refetch, isFetching, isPlaceholderData, isError } =
    useKnowledgeDocuments(query, { initialData });

  if (isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading documents">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <Alert variant="destructive">
          <AlertTitle>Unable to load the knowledge base</AlertTitle>
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
        title="No documents match your filters"
        description="Try a different search or clear the filters."
      />
    ) : (
      <EmptyState
        title="No knowledge yet"
        description="Write your first article (refund policy, shipping, FAQs), then publish it so the AI can use it."
        action={
          canCreate ? (
            <Link href="/dashboard/knowledge/new" className={buttonVariants()}>
              New document
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
        <KnowledgeTable documents={data.items} />
      </div>
      <Pagination
        page={data.page}
        pageSize={data.pageSize}
        total={data.total}
        totalPages={data.totalPages}
        hrefForPage={(page) => knowledgeHref(params, { page: String(page) })}
      />
    </div>
  );
}
