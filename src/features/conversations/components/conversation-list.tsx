import Link from "next/link";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ConversationJson } from "../api/types";
import { ConversationPriorityBadge, ConversationStatusBadge } from "./conversation-badges";

type Props = {
  conversations: ConversationJson[];
  selectedId: string | null;
  /** Builds the link that opens a conversation while preserving the current view/search. */
  hrefFor: (conversationId: string) => string;
};

export function ConversationList({ conversations, selectedId, hrefFor }: Props) {
  return (
    <ul className="border-border bg-card divide-border divide-y overflow-hidden rounded-xl border">
      {conversations.map((conversation) => {
        const selected = conversation.id === selectedId;
        return (
          <li key={conversation.id}>
            <Link
              href={hrefFor(conversation.id)}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "focus-visible:ring-ring flex flex-col gap-1 px-3 py-3 outline-none focus-visible:ring-2 focus-visible:ring-inset",
                selected ? "bg-accent" : "hover:bg-muted/60",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-2">
                  {conversation.unread ? (
                    <span
                      className="bg-primary size-2 shrink-0 rounded-full"
                      role="img"
                      aria-label="Unread"
                    />
                  ) : null}
                  <span
                    className={cn(
                      "truncate text-sm",
                      conversation.unread ? "font-semibold" : "font-medium",
                    )}
                  >
                    {conversation.customer.name}
                  </span>
                </span>
                <time
                  dateTime={new Date(conversation.lastMessageAt).toISOString()}
                  className="text-muted-foreground shrink-0 text-xs"
                >
                  {formatRelative(conversation.lastMessageAt)}
                </time>
              </div>
              <p className="truncate text-sm">{conversation.subject}</p>
              <p className="text-muted-foreground truncate text-xs">
                {conversation.lastMessagePreview
                  ? `${previewPrefix(conversation.lastMessageSenderType)}${conversation.lastMessagePreview}`
                  : "No messages yet"}
              </p>
              <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                <ConversationStatusBadge status={conversation.status} />
                <ConversationPriorityBadge priority={conversation.priority} />
                <span className="text-muted-foreground ml-auto truncate text-xs">
                  {conversation.assignee
                    ? (conversation.assignee.name ?? conversation.assignee.email)
                    : "Unassigned"}
                </span>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function previewPrefix(sender: ConversationJson["lastMessageSenderType"]): string {
  if (sender === "CUSTOMER" || sender === null) return "";
  return sender === "AI_AGENT" ? "AI: " : "You: ";
}
