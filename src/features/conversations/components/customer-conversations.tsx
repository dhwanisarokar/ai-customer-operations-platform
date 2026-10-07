import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatRelative } from "@/lib/format";
import type { ConversationDto } from "@/server/repositories/conversations";
import { ConversationPriorityBadge, ConversationStatusBadge } from "./conversation-badges";

/** The Conversations section of Customer 360. Server-rendered from the 360 payload. */
export function CustomerConversations({
  customerId,
  conversations,
  total,
  canCreate,
}: {
  customerId: string;
  conversations: ConversationDto[];
  total: number;
  canCreate: boolean;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <CardTitle>Conversations ({total})</CardTitle>
        {canCreate ? (
          <Link
            href={`/dashboard/inbox/new?customerId=${customerId}`}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            New
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        {conversations.length === 0 ? (
          <p className="text-muted-foreground text-sm">No conversations yet.</p>
        ) : (
          <ul className="divide-border flex flex-col divide-y">
            {conversations.map((conversation) => (
              <li key={conversation.id} className="py-3 first:pt-0 last:pb-0">
                <Link
                  href={`/dashboard/inbox?view=all&c=${conversation.id}`}
                  className="hover:text-primary flex flex-col gap-1 rounded-sm outline-none focus-visible:ring-2"
                >
                  <span className="flex items-center gap-2">
                    {conversation.unread ? (
                      <span
                        className="bg-primary size-2 rounded-full"
                        role="img"
                        aria-label="Unread"
                      />
                    ) : null}
                    <span className="truncate text-sm font-medium">{conversation.subject}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ConversationStatusBadge status={conversation.status} />
                    <ConversationPriorityBadge priority={conversation.priority} />
                    <span className="text-muted-foreground text-xs">
                      {conversation.assignee
                        ? (conversation.assignee.name ?? conversation.assignee.email)
                        : "Unassigned"}{" "}
                      &middot; {formatRelative(conversation.lastMessageAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {total > conversations.length ? (
          <Link
            href={`/dashboard/inbox?view=all&customer=${customerId}`}
            className="text-muted-foreground hover:text-foreground mt-3 block text-xs"
          >
            Showing the latest {conversations.length} of {total}. Open the inbox for the rest.
          </Link>
        ) : null}
      </CardContent>
    </Card>
  );
}
