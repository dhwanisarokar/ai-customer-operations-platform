"use client";

import { cn } from "@/lib/utils";

export type BubbleFrom = "visitor" | "ai" | "team";

/**
 * One message. Three authors look different on purpose:
 *   visitor: right, primary color         ai: left, outlined, labelled "AI assistant"
 *   team:    left, muted, with the person's name
 */
export function MessageBubble({
  from,
  body,
  author,
  status,
  onRetry,
  onDiscard,
}: {
  from: BubbleFrom;
  body: string;
  author?: string | null;
  status?: "sending" | "failed" | "sent";
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  const mine = from === "visitor";
  return (
    <div className={cn("flex flex-col gap-1", mine ? "items-end" : "items-start")}>
      {from === "ai" ? (
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <span aria-hidden>✦</span> AI assistant
        </span>
      ) : from === "team" ? (
        <span className="text-muted-foreground text-xs">
          {author ? `${author} · ` : ""}Support team
        </span>
      ) : null}
      <p
        className={cn(
          "max-w-[85%] rounded-2xl px-3 py-2 text-sm break-words whitespace-pre-wrap",
          from === "visitor" && "bg-primary text-primary-foreground",
          from === "ai" && "border-border bg-card text-card-foreground border",
          from === "team" && "bg-muted text-foreground",
          status === "sending" && "opacity-70",
        )}
      >
        {body}
      </p>
      {status === "sending" ? (
        <span className="text-muted-foreground text-xs">Sending…</span>
      ) : status === "sent" ? (
        <span className="text-muted-foreground text-xs">Sent</span>
      ) : status === "failed" ? (
        <span className="text-destructive flex gap-2 text-xs" role="alert">
          Not sent.
          <button type="button" className="underline" onClick={onRetry}>
            Retry
          </button>
          <button type="button" className="underline" onClick={onDiscard}>
            Discard
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** The assistant is working on an answer. Announced politely to screen readers. */
export function ThinkingBubble() {
  return (
    <div className="flex flex-col items-start gap-1" role="status" aria-live="polite">
      <span className="text-muted-foreground flex items-center gap-1 text-xs">
        <span aria-hidden>✦</span> AI assistant
      </span>
      <p className="border-border bg-card text-muted-foreground flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm">
        <span className="flex gap-1" aria-hidden>
          <span className="bg-muted-foreground size-1.5 animate-bounce rounded-full [animation-delay:-0.3s]" />
          <span className="bg-muted-foreground size-1.5 animate-bounce rounded-full [animation-delay:-0.15s]" />
          <span className="bg-muted-foreground size-1.5 animate-bounce rounded-full" />
        </span>
        AI is thinking…
      </p>
    </div>
  );
}
