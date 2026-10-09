"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ConversationJson } from "../api/types";
import { useSetHandlingMode } from "../hooks/mutations";

export const HANDLING_LABEL = { AI: "AI handling", HUMAN: "Human handling" } as const;

/**
 * Who answers the visitor of a web chat: the customer-facing AI or only people. Shown only for web chat
 * conversations. Switching to HUMAN stops automatic replies at once. Switching to AI asks for
 * confirmation first, because the visitor's NEXT messages may then be answered automatically (nothing
 * is sent by the switch itself). Without permission the mode is shown read-only; the server enforces
 * the permission and the eligibility either way.
 */
export function HandlingModeControl({
  conversation,
  canChange,
}: {
  conversation: Pick<ConversationJson, "id" | "channel" | "handlingMode">;
  canChange: boolean;
}) {
  const setMode = useSetHandlingMode();
  const [confirming, setConfirming] = useState(false);
  if (conversation.channel !== "WEB_CHAT") return null;

  const mode = conversation.handlingMode;
  const id = conversation.id;

  return (
    <div className="flex flex-col gap-1.5" data-testid="handling-mode">
      <span className="text-sm font-medium">Handling</span>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="bg-muted text-foreground rounded-md px-2 py-1 text-sm"
          aria-label={`Handling mode: ${HANDLING_LABEL[mode]}`}
        >
          {HANDLING_LABEL[mode]}
        </span>
        {canChange && !confirming ? (
          mode === "AI" ? (
            <Button
              variant="outline"
              size="sm"
              disabled={setMode.isPending}
              onClick={() => {
                setMode.reset();
                setMode.mutate({ conversationId: id, mode: "HUMAN" });
              }}
            >
              {setMode.isPending ? "Switching…" : "Switch to human"}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={setMode.isPending}
              onClick={() => {
                setMode.reset();
                setConfirming(true);
              }}
            >
              Switch to AI…
            </Button>
          )
        ) : null}
      </div>
      {confirming ? (
        <div
          role="group"
          aria-label="Confirm AI handling"
          className="border-border flex max-w-sm flex-col gap-2 rounded-md border p-2"
        >
          <p className="text-sm">
            Switch to AI handling? The visitor&apos;s next messages may be answered automatically by
            the AI. Nothing is sent when you switch.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={setMode.isPending}
              onClick={() =>
                setMode.mutate(
                  { conversationId: id, mode: "AI" },
                  { onSuccess: () => setConfirming(false) },
                )
              }
            >
              {setMode.isPending ? "Switching…" : "Switch to AI"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={setMode.isPending}
              onClick={() => {
                setMode.reset();
                setConfirming(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
      {setMode.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {setMode.error.message}
        </p>
      ) : null}
      {mode === "AI" ? (
        <p className="text-muted-foreground text-xs">
          The AI may answer new visitor messages until someone takes over.
        </p>
      ) : null}
    </div>
  );
}
