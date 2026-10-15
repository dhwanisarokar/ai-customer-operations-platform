import { CheckIcon, CircleHelpIcon, ClockIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { dayLabel, formatTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { EmailDeliveryJson } from "../api/types";
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
    intent?: string | null;
    sources: { documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }[];
  } | null;
  /**
   * The PERSISTED delivery state of an outbound email (server data, EMAIL conversations only). Not to be confused with
   * `delivery` below, which is the browser-side state of the HTTP request that submitted the message.
   */
  emailDelivery?: EmailDeliveryJson | null;
  /**
   * Delivery state of a message the current user just sent (UI state, never persisted).
   * Absent for everything loaded from the server in the normal way.
   */
  delivery?: DeliveryState;
  /** Why it failed, when `delivery` is "failed". */
  deliveryError?: string | null;
  /** Stable client identity of a message sent in this session; keeps its React key across reconciliation. */
  clientId?: string;
};

export type DeliveryState = "sending" | "sent" | "failed";

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
  onRetry,
  onDiscard,
}: {
  messages: TimelineMessage[];
  events: TimelineSystemEvent[];
  /** user id -> display name, for wording audit events. */
  names: ReadonlyMap<string, string>;
  onRetry?: (clientId: string) => void;
  onDiscard?: (clientId: string) => void;
}) {
  const entries: Entry[] = [
    ...messages.map((message): Entry => ({
      kind: "message",
      // Not-yet-confirmed messages sort after everything else (stable, in send order).
      at:
        message.delivery === "sending" || message.delivery === "failed"
          ? Number.MAX_SAFE_INTEGER
          : new Date(message.createdAt).getTime(),
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
            key={entry.kind === "message" ? (entry.message.clientId ?? entry.message.id) : entry.id}
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
              <MessageBubble message={entry.message} onRetry={onRetry} onDiscard={onDiscard} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function MessageBubble({
  message,
  onRetry,
  onDiscard,
}: {
  message: TimelineMessage;
  onRetry?: (clientId: string) => void;
  onDiscard?: (clientId: string) => void;
}) {
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
        message.delivery === "failed" && "border-destructive",
      )}
    >
      <header className="text-muted-foreground flex items-center gap-2 text-xs">
        {isNote ? <span className="text-foreground font-semibold">Internal note</span> : null}
        <span>{author}</span>
        <time dateTime={new Date(message.createdAt).toISOString()}>
          {formatTime(message.createdAt)}
        </time>
        {message.delivery ? <DeliveryIndicator state={message.delivery} /> : null}
      </header>
      <p className="text-sm wrap-break-word whitespace-pre-wrap">{message.body}</p>
      {isNote ? <p className="text-muted-foreground text-xs">Only visible to your team.</p> : null}
      {!isNote && !fromCustomer && !fromAi && message.emailDelivery ? (
        <EmailDeliveryLine delivery={message.emailDelivery} />
      ) : null}
      {fromAi ? <AiSources ai={message.ai ?? null} /> : null}
      {message.delivery === "failed" && message.clientId ? (
        <p role="alert" className="text-destructive flex flex-wrap items-center gap-2 text-xs">
          Not sent{message.deliveryError ? `: ${message.deliveryError}` : ""}
          <Button size="xs" variant="outline" onClick={() => onRetry?.(message.clientId!)}>
            Retry
          </Button>
          <Button size="xs" variant="ghost" onClick={() => onDiscard?.(message.clientId!)}>
            Discard
          </Button>
        </p>
      ) : null}
    </article>
  );
}

const FAILURE_TEXT: Record<NonNullable<EmailDeliveryJson["failure"]>, string> = {
  rejected: "The mail provider refused it.",
  retries_exhausted: "It could not be sent after several attempts.",
  sender_unavailable: "Email sending was switched off or changed before it could be sent.",
  message_missing: "The message could not be found.",
  provider_no_record: "The mail provider has no record of it, so it was not sent.",
  operator_confirmed_not_sent: "An operator confirmed it was not sent.",
};

/**
 * The persisted delivery state of an outbound email, in plain words. "Accepted" never claims delivery: the provider
 * took the email, and nothing here confirms it reached the customer's inbox. "Unknown" is neither success nor failure.
 */
function EmailDeliveryLine({ delivery }: { delivery: EmailDeliveryJson }) {
  const { state } = delivery;
  const text: Record<EmailDeliveryJson["state"], string> = {
    queued: "Queued to send by email",
    sending: "Sending by email\u2026",
    accepted:
      "Accepted by the mail provider \u00b7 delivery to the customer's inbox is not confirmed",
    retrying: delivery.retryAt
      ? `Temporary problem, retrying (next attempt around ${formatTime(delivery.retryAt)})`
      : "Temporary problem, retrying",
    failed: `Email not sent. ${delivery.failure ? FAILURE_TEXT[delivery.failure] : ""}`.trim(),
    unknown:
      "Outcome unknown \u00b7 it may or may not have been delivered. Check before sending it again.",
  };
  const Icon = {
    queued: ClockIcon,
    sending: ClockIcon,
    accepted: CheckIcon,
    retrying: ClockIcon,
    failed: TriangleAlertIcon,
    unknown: CircleHelpIcon,
  }[state];
  return (
    <p
      role={state === "failed" || state === "unknown" ? "alert" : "status"}
      aria-label={`Email delivery: ${state}`}
      data-delivery-state={state}
      className={cn(
        "flex items-start gap-1.5 text-xs",
        state === "failed" && "text-destructive",
        state === "unknown" && "text-chart-2 font-medium",
        state !== "failed" && state !== "unknown" && "text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span>{text[state]}</span>
    </p>
  );
}

/** A small icon next to the time: clock (sending), check (sent), warning (failed). Not a message. */
function DeliveryIndicator({ state }: { state: DeliveryState }) {
  const label = { sending: "Sending", sent: "Sent", failed: "Failed to send" }[state];
  const Icon = { sending: ClockIcon, sent: CheckIcon, failed: TriangleAlertIcon }[state];
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("ml-auto inline-flex", state === "failed" && "text-destructive")}
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  );
}

/** Only shows sources the retrieval actually returned and the model cited. Nothing is invented. */
function AiSources({ ai }: { ai: TimelineMessage["ai"] }) {
  // Small talk involved no knowledge lookup, so there is nothing to attribute (or disclaim).
  if (ai?.intent === "CONVERSATIONAL") return null;
  if (!ai || !ai.grounded || ai.sources.length === 0) {
    return <p className="text-muted-foreground text-xs">Not based on your knowledge base</p>;
  }
  const titles = [...new Set(ai.sources.map((source) => source.documentTitle))];
  return (
    <p className="text-muted-foreground text-xs">
      Based on: <span className="text-foreground font-medium">{titles.join(", ")}</span>
    </p>
  );
}
