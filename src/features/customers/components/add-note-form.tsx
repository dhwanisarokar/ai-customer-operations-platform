"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/api-client";

export function AddNoteForm({ customerId }: { customerId: string }) {
  const router = useRouter();
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) {
      setError("Note cannot be empty");
      return;
    }
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/customers/${customerId}/notes`, {
      method: "POST",
      body: { content },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors.content ?? result.message);
      return;
    }
    setContent("");
    startTransition(() => router.refresh());
  }

  return (
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
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "note-error" : undefined}
      />
      {error ? (
        <p id="note-error" role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
      <Button type="submit" size="sm" className="self-start" disabled={busy}>
        {busy ? "Adding..." : "Add note"}
      </Button>
    </form>
  );
}
