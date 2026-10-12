"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { usePortalSummary } from "../hooks";
import { usePortalInfo } from "../portal-context";
import { ConversationRow } from "./conversation-list-view";
import { ErrorPanel, LoadingRows } from "./portal-states";

/** Home: a summary of the customer's own conversations and the main actions. */
export function PortalHome() {
  const { slug, name } = usePortalInfo();
  const summary = usePortalSummary();
  const base = `/portal/${slug}`;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Welcome to {name} support</h1>
          <p className="text-muted-foreground text-sm">
            Follow your conversations with our team, start a new one, or browse the help center.
          </p>
        </div>
        <Link href={`${base}/conversations/new`} className={buttonVariants()}>
          New support conversation
        </Link>
      </div>

      {summary.isPending ? (
        <LoadingRows />
      ) : summary.isError ? (
        <ErrorPanel error={summary.error} onRetry={() => void summary.refetch()} />
      ) : (
        <>
          <section aria-label="Summary" className="grid gap-3 sm:grid-cols-2">
            <div className="border-border rounded-xl border p-4">
              <p className="text-muted-foreground text-sm">Open conversations</p>
              <p className="text-2xl font-semibold">{summary.data.open}</p>
            </div>
            <div className="border-border rounded-xl border p-4">
              <p className="text-muted-foreground text-sm">All conversations</p>
              <p className="text-2xl font-semibold">{summary.data.total}</p>
            </div>
          </section>

          <section aria-label="Recent conversations" className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Recently updated</h2>
              {summary.data.total > 0 ? (
                <Link href={`${base}/conversations`} className="text-primary text-sm underline">
                  See all
                </Link>
              ) : null}
            </div>
            {summary.data.recent.length === 0 ? (
              <EmptyState
                title="No conversations yet"
                description="When you contact support, your conversations will appear here."
                action={
                  <Link
                    href={`${base}/conversations/new`}
                    className={buttonVariants({ variant: "outline" })}
                  >
                    Start a conversation
                  </Link>
                }
              />
            ) : (
              <ul className="border-border divide-border bg-card divide-y overflow-hidden rounded-xl border">
                {summary.data.recent.map((conversation) => (
                  <li key={conversation.id}>
                    <ConversationRow
                      conversation={conversation}
                      href={`${base}/conversations/${conversation.id}`}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section
            aria-label="Help center"
            className="border-border flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
          >
            <div>
              <h2 className="font-semibold">Looking for an answer?</h2>
              <p className="text-muted-foreground text-sm">
                Search our help center for guides and policies.
              </p>
            </div>
            <Link href={`${base}/help`} className={buttonVariants({ variant: "outline" })}>
              Open help center
            </Link>
          </section>
        </>
      )}
    </div>
  );
}
