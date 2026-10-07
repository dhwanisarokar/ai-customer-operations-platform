"use client";

import { SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAiReply } from "../hooks/mutations";

/**
 * Asks the server-side AI agent to draft a reply from the organization's published knowledge. The
 * browser never talks to the AI provider: it calls our API, which retrieves, generates, validates
 * and stores the message. This is a plain mutation: nothing optimistic is shown. The real
 * AI_AGENT message appears (via refetch) only after the server has stored it.
 */
export function AskAiButton({
  conversationId,
  disabled,
}: {
  conversationId: string;
  /** e.g. the conversation is resolved. */
  disabled?: boolean;
}) {
  const ai = useAiReply(conversationId);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => ai.mutate()}
          disabled={ai.isPending || disabled}
        >
          <SparklesIcon aria-hidden="true" />
          {ai.isPending ? "Generating AI reply..." : "Ask AI"}
        </Button>
        <span className="text-muted-foreground text-xs">
          Drafts a reply from your published knowledge. Review it before relying on it.
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
