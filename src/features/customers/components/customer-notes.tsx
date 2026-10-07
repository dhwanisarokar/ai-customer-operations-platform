"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDateTime } from "@/lib/format";
import { useOutbox } from "@/lib/query/outbox";
import { DEFAULT_NOTES_PARAMS } from "../api/requests";
import type { CustomerNotesResponse } from "../api/types";
import { useAddCustomerNote } from "../hooks/mutations";
import { useCustomerNotes } from "../hooks/queries";

/**
 * Notes. A note you just wrote appears immediately as "Sending..." (from the outbox, never from
 * the cache) and becomes the real, server-timestamped note once accepted. A failed note stays
 * visible with Retry/Discard instead of silently disappearing.
 */
export function CustomerNotes({
  customerId,
  initialNotes,
  canAdd,
}: {
  customerId: string;
  initialNotes: CustomerNotesResponse;
  canAdd: boolean;
}) {
  const notes = useCustomerNotes(customerId, DEFAULT_NOTES_PARAMS, { initialData: initialNotes });
  const { mutateAsync } = useAddCustomerNote(customerId);
  const outbox = useOutbox(mutateAsync);
  const [content, setContent] = useState("");
  const [validation, setValidation] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) {
      setValidation("Note cannot be empty");
      return;
    }
    setValidation(null);
    void outbox.send({ content });
    setContent("");
  }

  const items = notes.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      {canAdd ? (
        <form onSubmit={onSubmit} className="flex flex-col gap-2" noValidate>
          <Label htmlFor="note-content" className="sr-only">
            Add a note
          </Label>
          <Textarea
            id="note-content"
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder="Add an internal note..."
            rows={3}
            maxLength={5000}
            aria-invalid={validation ? true : undefined}
            aria-describedby={validation ? "note-error" : undefined}
          />
          {validation ? (
            <p id="note-error" role="alert" className="text-destructive text-sm">
              {validation}
            </p>
          ) : null}
          <Button type="submit" size="sm" className="self-start">
            Add note
          </Button>
        </form>
      ) : null}

      <ul className="divide-border flex flex-col divide-y" aria-label="Notes">
        {outbox.items.map((item) => (
          <li
            key={item.clientId}
            className="flex flex-col gap-1 py-3 first:pt-0"
            aria-busy={item.status === "sending"}
          >
            <p className="text-sm break-words whitespace-pre-wrap">{item.input.content}</p>
            {item.status === "sending" ? (
              <p className="text-muted-foreground text-xs">Sending...</p>
            ) : (
              <p
                role="alert"
                className="text-destructive flex flex-wrap items-center gap-2 text-xs"
              >
                Not saved: {item.error}
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void outbox.retry(item.clientId)}
                >
                  Retry
                </Button>
                <Button size="xs" variant="ghost" onClick={() => outbox.discard(item.clientId)}>
                  Discard
                </Button>
              </p>
            )}
          </li>
        ))}
        {items.map((note) => (
          <li key={note.id} className="flex flex-col gap-1 py-3 first:pt-0">
            <p className="text-sm break-words whitespace-pre-wrap">{note.content}</p>
            <p className="text-muted-foreground text-xs">
              {note.author?.name ?? note.author?.email ?? "Former member"} &middot;{" "}
              {formatDateTime(note.createdAt)}
            </p>
          </li>
        ))}
        {items.length === 0 && outbox.items.length === 0 ? (
          <li className="text-muted-foreground text-sm">No notes yet.</li>
        ) : null}
      </ul>
    </div>
  );
}
