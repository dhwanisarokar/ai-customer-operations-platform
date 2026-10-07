import { Button } from "@/components/ui/button";
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
  /** Present for AI_AGENT messages: how the reply was produced (no prompts or secrets). */
  ai?: {
    grounded: boolean;
    sources: { documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }[];
  } | null;
};

/** A message the user just submitted that the server has not confirmed yet (see lib/query/outbox.ts). */
export type PendingMessage = {
  clientId: string;
  body: string;
  type: "MESSAGE" | "INTERNAL_NOTE";
  from: "USER" | "CUSTOMER";
  status: "sending" | "failed";
  error: string | null;
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
  pending = [],
  onRetry,
  onDiscard,
  aiPending = false,
}: {
  messages: TimelineMessage[];
  events: TimelineSystemEvent[];
  /** user id -> display name, for wording audit events. */
  names: ReadonlyMap<string, string>;
  /** Messages being sent or failed; shown after the confirmed history, clearly marked. */
  pending?: PendingMessage[];
  onRetry?: (clientId: string) => void;
  onDiscard?: (clientId: string) => void;
  /** An AI reply is being generated on the server (no placeholder message is created). */
  aiPending?: boolean;
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

  if (entries.length === 0 && pending.length === 0 && !aiPending) {
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
      {pending.map((item) => (
        <li key={item.clientId} className="flex flex-col gap-1">
          <article
            aria-label={
              item.type === "INTERNAL_NOTE" ? "Internal note (not sent)" : "Message (not sent)"
            }
            aria-busy={item.status === "sending"}
            className={cn(
              "flex max-w-[85%] flex-col gap-1 rounded-xl border px-3 py-2 opacity-80",
              item.type === "INTERNAL_NOTE"
                ? "border-chart-2 bg-chart-2/10 self-center border-dashed"
                : item.from === "CUSTOMER"
                  ? "bg-muted self-start"
                  : "bg-accent self-end",
              item.status === "failed" && "border-destructive",
            )}
          >
            <p className="text-sm break-words whitespace-pre-wrap">{item.body}</p>
            {item.status === "sending" ? (
              <p className="text-muted-foreground text-xs">Sending...</p>
            ) : (
              <p
                role="alert"
                className="text-destructive flex flex-wrap items-center gap-2 text-xs"
              >
                Failed to send: {item.error}
                <Button size="xs" variant="outline" onClick={() => onRetry?.(item.clientId)}>
                  Retry
                </Button>
                <Button size="xs" variant="ghost" onClick={() => onDiscard?.(item.clientId)}>
                  Discard
                </Button>
              </p>
            )}
          </article>
        </li>
      ))}
      {aiPending ? (
        <li role="status" className="text-muted-foreground self-end text-xs">
          AI Agent is writing a reply...
        </li>
      ) : null}
    </ol>
  );
}

function MessageBubble({ message }: { message: TimelineMessage }) {
  const isNote = message.messageType === "INTERNAL_NOTE";
  const fromCustomer = message.senderType === "CUSTOMER";
  const fromAi = message.senderType === "AI_AGENT";
  const author = fromCustomer
    ? "Customer"
    : fromAi
      ? "AI Agent"
      : message.senderType === "SYSTEM"
        ? "System"
        : (message.sender?.name ?? message.sender?.email ?? "Former member");

  return (
    <article
      aria-label={
        isNote
          ? "Internal note"
          : fromCustomer
            ? "Customer message"
            : fromAi
              ? "AI message"
              : "Agent message"
      }
      className={cn(
        "flex max-w-[85%] flex-col gap-1 rounded-xl border px-3 py-2",
        isNote && "border-chart-2 bg-chart-2/10 self-center border-dashed",
        !isNote && fromCustomer && "bg-muted self-start",
        !isNote && !fromCustomer && !fromAi && "bg-accent self-end",
        fromAi && "border-primary/40 bg-primary/5 self-end",
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
      {fromAi ? <AiSources ai={message.ai ?? null} /> : null}
    </article>
  );
}

/** Only shows sources the retrieval actually returned and the model cited. Nothing is invented. */
function AiSources({ ai }: { ai: TimelineMessage["ai"] }) {
  if (!ai || !ai.grounded || ai.sources.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        Not based on your knowledge base. Review before sending anything to the customer.
      </p>
    );
  }
  const titles = [...new Set(ai.sources.map((source) => source.documentTitle))];
  return (
    <p className="text-muted-foreground text-xs">
      Based on: <span className="text-foreground font-medium">{titles.join(", ")}</span>
    </p>
  );
}
