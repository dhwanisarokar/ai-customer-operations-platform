"use client";

import { SparklesIcon, TriangleAlertIcon } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { AiDraftResponse, SendMessageInput } from "../api/types";
import { MAX_MESSAGE_LENGTH } from "../schemas";

type Mode = "reply" | "note" | "customer";

const MODES: { id: Mode; label: string; placeholder: string; submit: string }[] = [
  {
    id: "reply",
    label: "Reply",
    placeholder: "Write a reply to the customer...",
    submit: "Send reply",
  },
  {
    id: "note",
    label: "Internal note",
    placeholder: "Write a note for your team (the customer will not see it)...",
    submit: "Add note",
  },
  {
    id: "customer",
    label: "Log customer message",
    placeholder: "Record something the customer told you...",
    submit: "Log message",
  },
];

const PAYLOAD: Record<Mode, Pick<SendMessageInput, "type" | "from">> = {
  reply: { type: "MESSAGE", from: "USER" },
  note: { type: "INTERNAL_NOTE", from: "USER" },
  customer: { type: "MESSAGE", from: "CUSTOMER" },
};

/**
 * The composer only collects input. Submitting hands it to the outbox (owned by the conversation
 * pane), which shows the message immediately as a normal bubble with a delivery icon and handles
 * success, failure and retry. The textarea therefore clears at once.
 */
export function MessageComposer({
  resolved,
  onSend,
  suggestion = null,
  onSuggestionClear,
}: {
  /** Agent replies are blocked on resolved conversations; notes and customer messages are not. */
  resolved: boolean;
  onSend: (input: SendMessageInput) => void;
  /**
   * An AI suggested reply to start from. It is placed IN this single box (editable), like any
   * draft; nothing is sent until the person sends it. Mount with a new `key` per suggestion so the
   * box is pre-filled once, then belongs to the person.
   */
  suggestion?: AiDraftResponse | null;
  /** Called when the suggestion is discarded or sent, so the parent can drop it. */
  onSuggestionClear?: () => void;
}) {
  const [mode, setMode] = useState<Mode>("reply");
  const [body, setBody] = useState(suggestion?.draft ?? "");
  const [suggestionActive, setSuggestionActive] = useState(suggestion !== null);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const current = MODES.find((candidate) => candidate.id === mode)!;
  const blocked = mode === "reply" && resolved;
  const isNote = mode === "note";
  const showSuggestion = suggestion !== null && suggestionActive && mode === "reply";

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (blocked) return;
    if (!body.trim()) {
      setError("Message cannot be empty");
      return;
    }
    setError(null);
    onSend({ body, ...PAYLOAD[mode] });
    setBody("");
    if (suggestionActive) {
      setSuggestionActive(false);
      onSuggestionClear?.();
    }
  }

  function discardSuggestion() {
    setBody("");
    setError(null);
    setSuggestionActive(false);
    onSuggestionClear?.();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      ref={formRef}
      onSubmit={submit}
      noValidate
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-2 md:p-3",
        isNote
          ? "border-chart-2 bg-chart-2/10 border-dashed"
          : showSuggestion
            ? "border-primary/40 bg-primary/5 border-dashed"
            : "bg-card",
      )}
    >
      <div role="radiogroup" aria-label="Composer mode" className="flex flex-wrap gap-1">
        {MODES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={mode === id}
            onClick={() => {
              setMode(id);
              setError(null);
            }}
            className={cn(
              "rounded-md px-2 py-0.5 text-xs transition-colors outline-none focus-visible:ring-2 md:px-2.5 md:py-1 md:text-sm",
              mode === id
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {suggestion && showSuggestion ? (
        <div
          role="status"
          aria-label="AI suggested reply"
          className="flex items-start justify-between gap-2 text-xs"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium">
              <SparklesIcon className="size-3.5" aria-hidden="true" />
              AI suggested reply
              <span className="text-muted-foreground font-normal">
                &middot; edit before sending
              </span>
            </span>
            {suggestion.grounded && suggestion.sources.length > 0 ? (
              <span className="text-muted-foreground">
                Based on:{" "}
                <span className="text-foreground font-medium">
                  {[...new Set(suggestion.sources.map((source) => source.documentTitle))].join(
                    ", ",
                  )}
                </span>
              </span>
            ) : suggestion.accountData ? (
              <span className="text-muted-foreground">
                Based on: <span className="text-foreground font-medium">customer record</span>
              </span>
            ) : suggestion.intent === "CONVERSATIONAL" ? null : (
              <span className="text-muted-foreground flex items-center gap-1">
                <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                Not based on your knowledge base
              </span>
            )}
          </div>
          <Button type="button" variant="ghost" size="xs" onClick={discardSuggestion}>
            Discard
          </Button>
        </div>
      ) : null}

      <Label htmlFor="composer-body" className="sr-only">
        {current.label}
      </Label>
      <Textarea
        id="composer-body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={current.placeholder}
        rows={suggestionActive ? 4 : 2}
        className="min-h-12 md:min-h-16"
        maxLength={MAX_MESSAGE_LENGTH}
        disabled={blocked}
        aria-invalid={error ? true : undefined}
      />

      {blocked ? (
        <p className="text-muted-foreground text-sm">
          This conversation is resolved. Reopen it to reply; internal notes are still allowed.
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center justify-end gap-2 md:justify-between">
        <span className="text-muted-foreground hidden text-xs md:inline">
          Ctrl/Cmd + Enter to send
        </span>
        <Button type="submit" size="sm" disabled={blocked}>
          {current.submit}
        </Button>
      </div>
    </form>
  );
}
