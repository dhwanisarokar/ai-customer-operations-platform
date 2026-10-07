import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import type { OrganizationContext } from "@/server/auth/context";
import { NotFoundError } from "@/server/errors";
import { getConversationTimeline } from "@/server/services/conversation-messages";
import { getConversation } from "@/server/services/conversations";
import { listMembers } from "@/server/services/memberships";
import { ConversationPriorityBadge, ConversationStatusBadge } from "./conversation-badges";
import { ConversationControls } from "./conversation-controls";
import { ConversationTimeline } from "./conversation-timeline";
import { MarkRead } from "./mark-read";
import { MessageComposer } from "./message-composer";

type Props = {
  ctx: OrganizationContext;
  conversationId: string;
  messageLimit: number;
  /** Link that closes the detail pane (used on small screens). */
  closeHref: string;
  /** Link that loads more history. */
  loadMoreHref: string;
};

export async function ConversationDetail({
  ctx,
  conversationId,
  messageLimit,
  closeHref,
  loadMoreHref,
}: Props) {
  let conversation: Awaited<ReturnType<typeof getConversation>>;
  try {
    conversation = await getConversation(ctx, conversationId);
  } catch (error) {
    if (error instanceof NotFoundError) {
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
    throw error;
  }

  const [timeline, members] = await Promise.all([
    getConversationTimeline(ctx, conversationId, messageLimit),
    listMembers(ctx),
  ]);
  const memberOptions = members.map((member) => ({
    id: member.userId,
    label: member.name ?? member.email,
  }));
  const names = new Map(memberOptions.map((member) => [member.id, member.label]));

  return (
    <section
      aria-label="Conversation"
      className="border-border bg-card flex min-h-[32rem] flex-col rounded-xl border"
    >
      <MarkRead conversationId={conversation.id} unread={conversation.unread} />

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
          conversationId={conversation.id}
          status={conversation.status}
          priority={conversation.priority}
          assigneeId={conversation.assignee?.id ?? null}
          currentUserId={ctx.user.id}
          members={memberOptions}
          canUpdate={ctx.can("update_conversations")}
          canAssignOthers={ctx.can("assign_conversations")}
        />
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {timeline.hasMore ? (
          <Link
            href={loadMoreHref}
            className={buttonVariants({ variant: "outline", size: "sm" }) + " self-center"}
          >
            Load earlier messages ({timeline.total - timeline.messages.length} more)
          </Link>
        ) : null}
        <ConversationTimeline messages={timeline.messages} events={timeline.events} names={names} />
      </div>

      {ctx.can("send_messages") ? (
        <div className="border-border border-t p-3">
          <MessageComposer
            conversationId={conversation.id}
            resolved={conversation.status === "RESOLVED"}
          />
        </div>
      ) : null}
    </section>
  );
}
