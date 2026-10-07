"use client";

import { SparklesIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/api-client";

/**
 * Asks the server-side AI agent to draft a reply from the organization's published knowledge. The
 * browser never talks to the AI provider: it calls our API, which retrieves, generates, validates
 * and stores the message. The AI only writes a reply into the conversation; it takes no actions.
 */
export function AskAiButton({
  conversationId,
  disabled,
}: {
  conversationId: string;
  /** e.g. the conversation is resolved. */
  disabled?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function ask() {
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/conversations/${conversationId}/ai-reply`, {
      method: "POST",
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={ask} disabled={busy || disabled}>
          <SparklesIcon aria-hidden="true" />
          {busy ? "Generating reply..." : "Ask AI"}
        </Button>
        <span className="text-muted-foreground text-xs">
          Drafts a reply from your published knowledge. Review it before relying on it.
        </span>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
