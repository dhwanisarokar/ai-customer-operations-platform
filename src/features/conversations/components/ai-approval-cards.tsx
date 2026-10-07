"use client";

import { ShieldAlertIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { ApprovalJson } from "../api/types";
import { useDecideApproval } from "../hooks/mutations";
import { useAiApprovals } from "../hooks/queries";

/**
 * Changes the AI asked for that need a human decision. Each card states exactly what will happen
 * (built by the server from current data). Approve/Reject call the server, which re-checks
 * authentication, tenant, permission, status and expiry itself: nothing here is a security
 * boundary, it only presents the choice.
 */
export function AiApprovalCards({
  conversationId,
  initial,
}: {
  conversationId: string;
  initial: ApprovalJson[];
}) {
  const { data } = useAiApprovals(conversationId, { initialData: { approvals: initial } });
  const pending = data?.approvals ?? [];
  // Results stay visible after the server stops listing the approval as pending.
  const [settled, setSettled] = useState<Record<string, ApprovalJson>>({});
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const cards = [
    ...pending.map((approval) => settled[approval.id] ?? approval),
    ...Object.values(settled).filter((approval) => !pending.some((p) => p.id === approval.id)),
  ].filter((approval) => !dismissed.has(approval.id));

  if (cards.length === 0) return null;

  return (
    <div className="flex max-h-56 flex-col gap-2 overflow-y-auto" aria-label="AI actions">
      {cards.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          conversationId={conversationId}
          onSettled={(next) => setSettled((current) => ({ ...current, [next.id]: next }))}
          onDismiss={() => setDismissed((current) => new Set(current).add(approval.id))}
        />
      ))}
    </div>
  );
}

function ApprovalCard({
  approval,
  conversationId,
  onSettled,
  onDismiss,
}: {
  approval: ApprovalJson;
  conversationId: string;
  onSettled: (approval: ApprovalJson) => void;
  onDismiss: () => void;
}) {
  const decide = useDecideApproval(conversationId);
  const expired = approval.status === "EXPIRED" || new Date(approval.expiresAt) <= new Date();
  const open = approval.status === "PENDING";
  const busy = decide.isPending;

  function act(action: "approve" | "reject") {
    // Guard against double clicks; the server is idempotent as well (it executes once).
    if (busy) return;
    decide.mutate(
      { approvalId: approval.id, action },
      { onSuccess: ({ approval: next }) => onSettled(next) },
    );
  }

  return (
    <section
      aria-label="AI action requires approval"
      className="border-chart-2 bg-chart-2/10 flex flex-col gap-2 rounded-xl border border-dashed p-2 md:p-3"
    >
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <ShieldAlertIcon className="size-4" aria-hidden="true" />
        {open ? "AI action requires approval" : "AI action"}
      </h3>
      <div className="flex flex-col gap-1 text-sm">
        <p className="font-medium break-words">{approval.preview.title}</p>
        <ul className="flex flex-col gap-0.5">
          {approval.preview.lines.map((line) => (
            <li key={line.label} className="text-muted-foreground break-words">
              <span className="text-foreground">{line.label}:</span>{" "}
              {line.from !== null && line.to !== null ? (
                <>
                  {line.from} <span aria-hidden="true">&rarr;</span>
                  <span className="sr-only"> changes to </span> {line.to}
                </>
              ) : (
                (line.to ?? line.from)
              )}
            </li>
          ))}
        </ul>
      </div>

      {open && !expired ? (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => act("reject")} disabled={busy}>
            Reject
          </Button>
          <Button size="sm" onClick={() => act("approve")} disabled={busy}>
            {busy && decide.variables?.action === "approve" ? "Approving..." : "Approve"}
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-xs">
          <p role="status" className="text-muted-foreground">
            {outcomeText(approval, expired)}
          </p>
          <Button variant="ghost" size="xs" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}

      {decide.error ? (
        <p role="alert" className="text-destructive text-sm">
          {decide.error.message}
        </p>
      ) : null}
    </section>
  );
}

function outcomeText(approval: ApprovalJson, expired: boolean): string {
  switch (approval.status) {
    case "EXECUTED":
      return "Approved and applied.";
    case "REJECTED":
      return "Rejected. Nothing was changed.";
    case "FAILED":
      return "Approved, but the change could not be applied. Nothing was changed.";
    case "APPROVED":
      return "Approved. Applying...";
    default:
      return expired ? "Expired. Ask the AI again if you still want this change." : "";
  }
}
