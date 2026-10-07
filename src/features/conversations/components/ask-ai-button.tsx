"use client";

import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AiDraftResponse } from "../api/types";
import { useAiDraft } from "../hooks/mutations";

/**
 * Asks the server-side AI agent for a SUGGESTED reply. The browser never talks to the AI provider:
 * it calls our API, which retrieves, generates and validates. Nothing is sent to the customer and
 * nothing is stored: the result is handed to `onDraft` for a person to review. Asking again simply
 * produces a new draft that replaces the current one.
 */
export function AskAiButton({
  conversationId,
  disabled,
  onDraft,
}: {
  conversationId: string;
  /** e.g. the conversation is resolved. */
  disabled?: boolean;
  onDraft: (draft: AiDraftResponse) => void;
}) {
  const ai = useAiDraft(conversationId);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => ai.mutate(undefined, { onSuccess: (data) => onDraft(data) })}
          disabled={ai.isPending || disabled}
        >
          <SparklesIcon aria-hidden="true" />
          {ai.isPending ? "Generating AI draft..." : "Ask AI"}
        </Button>
        <span className="text-muted-foreground hidden text-xs sm:inline">
          Suggests a reply from your published knowledge. Nothing is sent until you send it.
        </span>
      </div>
      {ai.error ? (
        <p role="alert" className="text-destructive text-sm">
          {ai.error.message}
        </p>
      ) : null}
    </div>
  );
}
