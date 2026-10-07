import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Pagination } from "@/components/shared/pagination";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConversationDetail } from "@/features/conversations/components/conversation-detail";
import { ConversationList } from "@/features/conversations/components/conversation-list";
import { InboxSidebar } from "@/features/conversations/components/inbox-sidebar";
import { inboxHref, parseInboxParams } from "@/features/conversations/inbox-params";
import { flattenSearchParams, type RawSearchParams } from "@/features/customers/list-params";
import { cn } from "@/lib/utils";
import { requirePageContext } from "@/server/auth/page-context";
import { listConversations } from "@/server/services/conversations";

export const dynamic = "force-dynamic";

const MESSAGE_PAGE = 50;

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const ctx = await requirePageContext();
  const raw = flattenSearchParams(await searchParams);
  const params = parseInboxParams(raw);
  const messageLimit = Math.min(Math.max(Number(raw.msgs) || MESSAGE_PAGE, MESSAGE_PAGE), 200);

  const result = await listConversations(ctx, params.query);
  const current = {
    view: params.view,
    q: params.q,
    page: params.page,
    c: params.selectedId,
    customer: params.customerId,
  };
  const hrefFor = (id: string) => inboxHref(current, { c: id });
  const closeHref = inboxHref(current, { c: null });
  const hasSelection = params.selectedId !== null;

  return (
    <main className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
        <div className="flex items-center gap-2">
          <form method="get" action="/dashboard/inbox" role="search" className="flex gap-2">
            {params.view !== "open" ? (
              <input type="hidden" name="view" value={params.view} />
            ) : null}
            {params.customerId ? (
              <input type="hidden" name="customer" value={params.customerId} />
            ) : null}
            <Input
              name="q"
              type="search"
              defaultValue={params.q}
              placeholder="Search subject or customer"
              aria-label="Search conversations"
              maxLength={100}
              className="w-64"
            />
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {ctx.can("create_conversations") ? (
            <Link href="/dashboard/inbox/new" className={buttonVariants()}>
              New conversation
            </Link>
          ) : null}
        </div>
      </div>

      {params.customerId ? (
        <p className="text-muted-foreground text-sm">
          Showing conversations for one customer.{" "}
          <Link
            href={inboxHref({ ...current, c: null }, { customer: null })}
            className="text-foreground underline underline-offset-4"
          >
            Show all
          </Link>
        </p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[13rem_minmax(20rem,26rem)_1fr]">
        <aside className={cn(hasSelection && "hidden lg:block")}>
          <InboxSidebar view={params.view} q={params.q} customer={params.customerId} />
        </aside>

        <div className={cn("flex flex-col gap-3", hasSelection && "hidden lg:flex")}>
          {result.total === 0 ? (
            params.q || params.view !== "open" ? (
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
                  ctx.can("create_conversations") ? (
                    <Link href="/dashboard/inbox/new" className={buttonVariants()}>
                      New conversation
                    </Link>
                  ) : undefined
                }
              />
            )
          ) : (
            <>
              <ConversationList
                conversations={result.items}
                selectedId={params.selectedId}
                hrefFor={hrefFor}
              />
              <Pagination
                page={result.page}
                pageSize={result.pageSize}
                total={result.total}
                totalPages={result.totalPages}
                hrefForPage={(page) => inboxHref({ ...current, c: null }, { page })}
              />
            </>
          )}
        </div>

        <div className={cn(!hasSelection && "hidden lg:block")}>
          {params.selectedId ? (
            <ConversationDetail
              ctx={ctx}
              conversationId={params.selectedId}
              messageLimit={messageLimit}
              closeHref={closeHref}
              loadMoreHref={`${hrefFor(params.selectedId)}&msgs=${messageLimit + MESSAGE_PAGE}`}
            />
          ) : (
            <div className="hidden lg:block">
              <Alert>
                <AlertDescription>Select a conversation to read it and reply.</AlertDescription>
              </Alert>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
