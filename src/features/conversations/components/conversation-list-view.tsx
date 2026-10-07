"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { ConversationListResponse } from "../api/types";
import { useConversations } from "../hooks/queries";
import { inboxHref, type InboxViewId } from "../inbox-params";
import type { ListConversationsQuery } from "../schemas";
import { ConversationList } from "./conversation-list";

type Props = {
  query: ListConversationsQuery;
  /** Where the user is in the inbox, used to build links that keep the current view and search. */
  current: {
    view: InboxViewId;
    q: string;
    page: number;
    c: string | null;
    customer: string | null;
  };
  initialData: ConversationListResponse;
  canCreate: boolean;
};

/**
 * The inbox list. The URL decides WHICH list (view, search, page); TanStack Query owns its data, so
 * status/priority/assignee/read changes made in the open conversation show up here instantly
 * (optimistic cache updates) and are reconciled with the server afterwards.
 */
export function ConversationListView({ query, current, initialData, canCreate }: Props) {
  const { data, isPending, error, refetch, isFetching, isPlaceholderData, isError } =
    useConversations(query, { initialData });

  if (isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading conversations">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-24 w-full" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <Alert variant="destructive">
          <AlertTitle>Unable to load conversations</AlertTitle>
          <AlertDescription>{error?.message ?? "Please try again."}</AlertDescription>
        </Alert>
        <Button variant="outline" className="self-start" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  if (data.total === 0) {
    return current.q || current.view !== "open" || current.customer ? (
      <EmptyState
        title="No conversations match your filters"
        description="Try another view or a different search."
        action={
          <Link href="/dashboard/inbox" className={buttonVariants({ variant: "outline" })}>
            Back to Open
          </Link>
        }
      />
    ) : (
      <EmptyState
        title="No conversations yet"
        description="Start a conversation with a customer to see it here."
        action={
          canCreate ? (
            <Link href="/dashboard/inbox/new" className={buttonVariants()}>
              New conversation
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
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
        <ConversationList
          conversations={data.items}
          selectedId={current.c}
          hrefFor={(id) => inboxHref(current, { c: id })}
        />
      </div>
      <Pagination
        page={data.page}
        pageSize={data.pageSize}
        total={data.total}
        totalPages={data.totalPages}
        hrefForPage={(page) => inboxHref({ ...current, c: null }, { page })}
      />
    </div>
  );
}
