import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConversationListView } from "@/features/conversations/components/conversation-list-view";
import { ConversationPane } from "@/features/conversations/components/conversation-pane";
import { InboxSidebar } from "@/features/conversations/components/inbox-sidebar";
import { inboxHref, parseInboxParams } from "@/features/conversations/inbox-params";
import { DEFAULT_EVENTS_PARAMS, DEFAULT_MESSAGES_LIMIT } from "@/features/conversations/api/types";
import { flattenSearchParams, type RawSearchParams } from "@/features/customers/list-params";
import { serialize } from "@/lib/query/serialize";
import { cn } from "@/lib/utils";
import type { OrganizationContext } from "@/server/auth/context";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { listConversationEvents, listMessages } from "@/server/services/conversation-messages";
import { getConversation, listConversations } from "@/server/services/conversations";
import { listMembers } from "@/server/services/memberships";

export const dynamic = "force-dynamic";

/**
 * Server component: authenticates, resolves the tenant and fetches the first render of the list and
 * of the selected conversation. The client views (TanStack Query) own the data from there on.
 * The URL holds only UI selection (view, search, page, selected conversation id), never entities.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const ctx = await requirePageContext();
  const params = parseInboxParams(flattenSearchParams(await searchParams));

  const result = await listConversations(ctx, params.query);
  const current = {
    view: params.view,
    q: params.q,
    page: params.page,
    c: params.selectedId,
    customer: params.customerId,
  };
  const closeHref = inboxHref(current, { c: null });
  const hasSelection = params.selectedId !== null;

  return (
    <main className="mx-auto flex h-full min-h-0 w-full max-w-[96rem] flex-col gap-4 px-4 py-4 md:py-6">
      <div
        className={cn(
          "flex shrink-0 flex-wrap items-center justify-between gap-3",
          // Phones show one pane at a time: the open conversation owns the whole screen.
          hasSelection && "hidden md:flex",
        )}
      >
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
              className="w-full min-w-0 sm:w-64"
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
        <p
          className={cn(
            "text-muted-foreground shrink-0 text-sm",
            hasSelection && "hidden md:block",
          )}
        >
          Showing conversations for one customer.{" "}
          <Link
            href={inboxHref({ ...current, c: null }, { customer: null })}
            className="text-foreground underline underline-offset-4"
          >
            Show all
          </Link>
        </p>
      ) : null}

      {/* lg: filters | list | conversation. md: list | conversation (filters become a compact row).
          below md: list OR conversation. Every pane scrolls on its own; the page does not. */}
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-4 md:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)] lg:grid-cols-[13rem_minmax(20rem,26rem)_minmax(0,1fr)]">
        <aside className="hidden min-h-0 overflow-y-auto lg:block">
          <InboxSidebar view={params.view} q={params.q} customer={params.customerId} />
        </aside>

        <div
          className={cn("flex min-h-0 min-w-0 flex-col gap-3", hasSelection && "hidden md:flex")}
        >
          <div className="shrink-0 overflow-x-auto lg:hidden">
            <InboxSidebar view={params.view} q={params.q} customer={params.customerId} compact />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <ConversationListView
              query={params.query}
              current={current}
              initialData={serialize(result)}
              canCreate={ctx.can("create_conversations")}
            />
          </div>
        </div>

        <div className={cn("flex min-h-0 min-w-0 flex-col", !hasSelection && "hidden md:flex")}>
          {params.selectedId ? (
            <SelectedConversation
              ctx={ctx}
              conversationId={params.selectedId}
              closeHref={closeHref}
            />
          ) : (
            <Alert>
              <AlertDescription>Select a conversation to read it and reply.</AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    </main>
  );
}

async function loadSelected(ctx: OrganizationContext, conversationId: string) {
  try {
    const [conversation, messages, events, members] = await Promise.all([
      getConversation(ctx, conversationId),
      listMessages(ctx, conversationId, { limit: DEFAULT_MESSAGES_LIMIT, includeInternal: true }),
      listConversationEvents(ctx, conversationId, DEFAULT_EVENTS_PARAMS),
      listMembers(ctx),
    ]);
    return serialize({ conversation: { conversation }, messages, events, members: { members } });
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

async function SelectedConversation({
  ctx,
  conversationId,
  closeHref,
}: {
  ctx: OrganizationContext;
  conversationId: string;
  closeHref: string;
}) {
  const initial = await loadSelected(ctx, conversationId);

  if (!initial) {
    return (
      <EmptyState
        title="Conversation not found"
        description="It may have been removed, or you may not have access to it."
        action={
          <Link href={closeHref} className={buttonVariants({ variant: "outline" })}>
            Back to inbox
          </Link>
        }
      />
    );
  }

  return (
    <ConversationPane
      // A fresh pane (and state) per conversation.
      key={conversationId}
      conversationId={conversationId}
      initial={initial}
      currentUserId={ctx.user.id}
      can={{
        update: ctx.can("update_conversations"),
        assign: ctx.can("assign_conversations"),
        send: ctx.can("send_messages"),
      }}
      closeHref={closeHref}
    />
  );
}
