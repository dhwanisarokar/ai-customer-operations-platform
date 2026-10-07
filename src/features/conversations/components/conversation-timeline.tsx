import { dayLabel, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { describeEvent, MESSAGE_EVENT_TYPES, type TimelineEvent } from "../event-text";

export type TimelineMessage = {
  id: string;
  senderType: string;
  messageType: string;
  body: string;
  createdAt: Date | string;
  sender: { id: string; name: string | null; email: string } | null;
};

export type TimelineSystemEvent = TimelineEvent & { id: string; createdAt: Date | string };

type Entry =
  | { kind: "message"; at: number; message: TimelineMessage }
  | { kind: "event"; at: number; id: string; text: string; createdAt: Date | string };

/**
 * Chronological conversation view. Four visually distinct kinds of entries:
 * customer messages, agent messages, internal notes (dashed, labelled, never customer-facing),
 * and system lines for audit events (status, priority, assignment changes).
 */
export function ConversationTimeline({
  messages,
  events,
  names,
}: {
  messages: TimelineMessage[];
  events: TimelineSystemEvent[];
  /** user id -> display name, for wording audit events. */
  names: ReadonlyMap<string, string>;
}) {
  const entries: Entry[] = [
    ...messages.map((message): Entry => ({
      kind: "message",
      at: new Date(message.createdAt).getTime(),
      message,
    })),
    ...events
      .filter((event) => !MESSAGE_EVENT_TYPES.has(event.type))
      .map((event): Entry => ({
        kind: "event",
        at: new Date(event.createdAt).getTime(),
        id: event.id,
        text: describeEvent(event, names),
        createdAt: event.createdAt,
      })),
  ].sort((a, b) => a.at - b.at);

  if (entries.length === 0) {
    return <p className="text-muted-foreground py-8 text-center text-sm">No messages yet.</p>;
  }

  const days = entries.map((entry) =>
    dayLabel(entry.kind === "message" ? entry.message.createdAt : entry.createdAt),
  );
  return (
    <ol className="flex flex-col gap-3" aria-label="Conversation history">
      {entries.map((entry, index) => {
        const day = days[index];
        const showDay = index === 0 || day !== days[index - 1];
        return (
          <li
            key={entry.kind === "message" ? entry.message.id : entry.id}
            className="flex flex-col gap-3"
          >
            {showDay ? (
              <p className="text-muted-foreground text-center text-xs font-medium tracking-wide uppercase">
                {day}
              </p>
            ) : null}
            {entry.kind === "event" ? (
              <p className="text-muted-foreground text-center text-xs">
                {entry.text} &middot; {formatTime(entry.createdAt)}
              </p>
            ) : (
              <MessageBubble message={entry.message} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function MessageBubble({ message }: { message: TimelineMessage }) {
  const isNote = message.messageType === "INTERNAL_NOTE";
  const fromCustomer = message.senderType === "CUSTOMER";
  const author = fromCustomer
    ? "Customer"
    : message.senderType === "SYSTEM"
      ? "System"
      : (message.sender?.name ?? message.sender?.email ?? "Former member");

  return (
    <article
      aria-label={isNote ? "Internal note" : fromCustomer ? "Customer message" : "Agent message"}
      className={cn(
        "flex max-w-[85%] flex-col gap-1 rounded-xl border px-3 py-2",
        isNote && "border-chart-2 bg-chart-2/10 self-center border-dashed",
        !isNote && fromCustomer && "bg-muted self-start",
        !isNote && !fromCustomer && "bg-accent self-end",
      )}
    >
      <header className="text-muted-foreground flex items-center gap-2 text-xs">
        {isNote ? <span className="text-foreground font-semibold">Internal note</span> : null}
        <span>{author}</span>
        <time dateTime={new Date(message.createdAt).toISOString()}>
          {formatTime(message.createdAt)}
        </time>
      </header>
      <p className="text-sm break-words whitespace-pre-wrap">{message.body}</p>
      {isNote ? <p className="text-muted-foreground text-xs">Only visible to your team.</p> : null}
    </article>
  );
}
