"use client";

import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { formatRelative } from "@/lib/format";
import { usePortalConversations } from "../hooks";
import { usePortalInfo } from "../portal-context";
import { PORTAL_PAGE_SIZE, type PortalConversationDto } from "../types";
import { ErrorPanel, LoadingRows } from "./portal-states";

const STATUS_LABEL = { OPEN: "Open", PENDING: "Pending", RESOLVED: "Resolved" } as const;
const FROM_PREFIX = { customer: "You: ", ai: "AI: ", team: "Support: " } as const;

export function ConversationRow({
  conversation,
  href,
}: {
  conversation: PortalConversationDto;
  href: string;
}) {
  const from = conversation.lastMessageFrom;
  return (
    <Link href={href} className="hover:bg-muted/60 flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-sm font-medium">{conversation.subject}</span>
        <time
          dateTime={conversation.lastMessageAt}
          className="text-muted-foreground shrink-0 text-xs"
        >
          {formatRelative(conversation.lastMessageAt)}
        </time>
      </div>
      <p className="text-muted-foreground truncate text-sm">
        {conversation.lastMessagePreview
          ? `${from ? FROM_PREFIX[from] : ""}${conversation.lastMessagePreview}`
          : "No messages yet"}
      </p>
      <div className="flex items-center gap-2">
        <Badge variant={conversation.status === "RESOLVED" ? "outline" : "secondary"}>
          {STATUS_LABEL[conversation.status]}
        </Badge>
        {conversation.humanRequested ? <Badge variant="outline">Support requested</Badge> : null}
      </div>
    </Link>
  );
}

/** Paginated list of the customer's own conversations. */
export function ConversationListView() {
  const { slug } = usePortalInfo();
  const [page, setPage] = useState(1);
  const query = usePortalConversations(page);
  const base = `/portal/${slug}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">My conversations</h1>
        <Link href={`${base}/conversations/new`} className={buttonVariants()}>
          New support conversation
        </Link>
      </div>

      {query.isPending ? (
        <LoadingRows />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.total === 0 ? (
        <EmptyState
          title="No conversations yet"
          description="Start a conversation to get help from our team."
        />
      ) : (
        <>
          <ul className="border-border divide-border bg-card divide-y overflow-hidden rounded-xl border">
            {query.data.items.map((conversation) => (
              <li key={conversation.id}>
                <ConversationRow
                  conversation={conversation}
                  href={`${base}/conversations/${conversation.id}`}
                />
              </li>
            ))}
          </ul>
          <nav aria-label="Pagination" className="flex items-center justify-between gap-4 text-sm">
            <p className="text-muted-foreground">
              Page {query.data.page} of{" "}
              {Math.max(1, Math.ceil(query.data.total / PORTAL_PAGE_SIZE))}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page * PORTAL_PAGE_SIZE >= query.data.total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </nav>
        </>
      )}
    </div>
  );
}
