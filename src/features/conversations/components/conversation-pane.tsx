"use client";

import { useIsMutating } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useMembers } from "@/features/organizations/hooks/queries";
import { ApiError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { mutationKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import {
  DEFAULT_MESSAGES_LIMIT,
  MAX_MESSAGES_LIMIT,
  type ConversationDetailResponse,
  type ConversationEventsResponse,
  type MembersResponse,
  type MessagesResponse,
} from "../api/types";
import { useMarkConversationRead, useMessageOutbox } from "../hooks/mutations";
import { useConversation, useConversationEvents, useConversationMessages } from "../hooks/queries";
import { AskAiButton } from "./ask-ai-button";
import { ConversationPriorityBadge, ConversationStatusBadge } from "./conversation-badges";
import { ConversationControls } from "./conversation-controls";
import { ConversationTimeline } from "./conversation-timeline";
import { MessageComposer } from "./message-composer";

type Props = {
  conversationId: string;
  /** Fetched on the server for first paint. TanStack Query owns the data afterwards. */
  initial: {
    conversation: ConversationDetailResponse;
    messages: MessagesResponse;
    events: ConversationEventsResponse;
    members: MembersResponse;
  };
  currentUserId: string;
  /** UI hints computed by the server. The API enforces every permission regardless. */
  can: { update: boolean; assign: boolean; send: boolean };
  /** Closes the pane (small screens). */
  closeHref: string;
};

/**
 * The open conversation: header + controls, history, composer.
 *
 * Server data (conversation, messages, events, members) comes from four queries. The only local
 * state is UI state: how many messages are loaded and the outbox of not-yet-confirmed messages.
 * Mount this with `key={conversationId}` so switching conversations starts clean.
 */
export function ConversationPane({
  conversationId,
  initial,
  currentUserId,
  can,
  closeHref,
}: Props) {
  const org = useOrganizationScope();
  const [limit, setLimit] = useState(DEFAULT_MESSAGES_LIMIT);

  const conversationQuery = useConversation(conversationId, { initialData: initial.conversation });
  const messagesQuery = useConversationMessages(
    conversationId,
    { limit, includeInternal: true },
    { initialData: limit === DEFAULT_MESSAGES_LIMIT ? initial.messages : undefined },
  );
  const eventsQuery = useConversationEvents(conversationId, undefined, {
    initialData: initial.events,
  });
  const membersQuery = useMembers({ initialData: initial.members });

  const outbox = useMessageOutbox(conversationId);
  const aiRunning = useIsMutating({ mutationKey: mutationKeys.aiReply(org, conversationId) }) > 0;

  // Opening a conversation marks it read for this member (optimistic; one attempt per open, so a
  // rollback after a failure cannot loop).
  const { mutate: markAsRead } = useMarkConversationRead();
  const markedRef = useRef(false);
  const conversation = conversationQuery.data?.conversation;
  const unread = conversation?.unread ?? false;
  useEffect(() => {
    if (unread && !markedRef.current) {
      markedRef.current = true;
      markAsRead({ conversationId });
    }
  }, [unread, conversationId, markAsRead]);

  const members = useMemo(
    () =>
      (membersQuery.data?.members ?? []).map((member) => ({
        id: member.userId,
        label: member.name ?? member.email,
        email: member.email,
        name: member.name,
      })),
    [membersQuery.data],
  );
  const names = useMemo(
    () => new Map(members.map((member) => [member.id, member.label])),
    [members],
  );

  const messages = messagesQuery.data;
  const events = useMemo(() => {
    const ascending = [...(eventsQuery.data?.items ?? [])].reverse();
    // Only show audit events inside the time window of the loaded messages.
    const since = messages?.hasMore ? messages.items[0]?.createdAt : undefined;
    return since ? ascending.filter((event) => event.createdAt >= since) : ascending;
  }, [eventsQuery.data, messages]);

  if (!conversation) {
    if (conversationQuery.isPending) return <PaneSkeleton />;
    const notFound =
      conversationQuery.error instanceof ApiError && conversationQuery.error.status === 404;
    return notFound ? (
      <EmptyState
        title="Conversation not found"
        description="It may have been removed, or you may not have access to it."
        action={
          <Link href={closeHref} className={buttonVariants({ variant: "outline" })}>
            Back to inbox
          </Link>
        }
      />
    ) : (
      <div className="flex flex-col gap-3" role="alert">
        <Alert variant="destructive">
          <AlertDescription>
            {conversationQuery.error?.message ?? "Unable to load this conversation."}
          </AlertDescription>
        </Alert>
        <Button
          variant="outline"
          className="self-start"
          onClick={() => conversationQuery.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }

  const resolved = conversation.status === "RESOLVED";

  return (
    <section
      aria-label="Conversation"
      className="border-border bg-card flex min-h-[32rem] flex-col rounded-xl border"
    >
      <header className="border-border flex flex-col gap-3 border-b p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold">{conversation.subject}</h2>
            <p className="text-muted-foreground text-sm">
              <Link
                href={`/dashboard/customers/${conversation.customer.id}`}
                className="hover:text-foreground underline-offset-4 hover:underline"
              >
                {conversation.customer.name}
              </Link>
              {conversation.customer.company ? ` · ${conversation.customer.company}` : ""}
              {" · "}started {formatDateTime(conversation.createdAt)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ConversationStatusBadge status={conversation.status} />
            <ConversationPriorityBadge priority={conversation.priority} showNormal />
            <Link
              href={closeHref}
              className={buttonVariants({ variant: "ghost", size: "sm" }) + " lg:hidden"}
            >
              Close
            </Link>
          </div>
        </div>
        <ConversationControls
          conversation={conversation}
          currentUserId={currentUserId}
          members={members}
          canUpdate={can.update}
          canAssignOthers={can.assign}
        />
      </header>

      <div
        className="flex flex-1 flex-col gap-3 overflow-y-auto p-4"
        aria-busy={messagesQuery.isFetching}
      >
        {messages?.hasMore ? (
          limit < MAX_MESSAGES_LIMIT ? (
            <Button
              variant="outline"
              size="sm"
              className="self-center"
              onClick={() =>
                setLimit((current) =>
                  Math.min(current + DEFAULT_MESSAGES_LIMIT, MAX_MESSAGES_LIMIT),
                )
              }
            >
              Load earlier messages ({messages.total - messages.items.length} more)
            </Button>
          ) : (
            <p className="text-muted-foreground self-center text-xs">
              Showing the latest {MAX_MESSAGES_LIMIT} messages.
            </p>
          )
        ) : null}
        {messagesQuery.isError && !messages ? (
          <div role="alert" className="flex items-center gap-2 text-sm">
            <span className="text-destructive">Could not load messages.</span>
            <Button size="xs" variant="outline" onClick={() => messagesQuery.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <ConversationTimeline
            messages={messages?.items ?? []}
            events={events}
            names={names}
            pending={outbox.items.map((item) => ({
              clientId: item.clientId,
              body: item.input.body,
              type: item.input.type,
              from: item.input.from,
              status: item.status,
              error: item.error,
            }))}
            onRetry={(clientId) => void outbox.retry(clientId)}
            onDiscard={outbox.discard}
            aiPending={aiRunning}
          />
        )}
      </div>

      {can.send ? (
        <div className="border-border flex flex-col gap-3 border-t p-3">
          <AskAiButton conversationId={conversationId} disabled={resolved} />
          <MessageComposer resolved={resolved} onSend={(input) => void outbox.send(input)} />
        </div>
      ) : null}
    </section>
  );
}

function PaneSkeleton() {
  return (
    <div
      className="border-border bg-card flex min-h-[32rem] flex-col gap-3 rounded-xl border p-4"
      aria-busy="true"
      aria-label="Loading conversation"
    >
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
