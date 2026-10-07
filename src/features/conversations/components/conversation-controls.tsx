"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { NativeSelect } from "@/components/shared/native-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api-client";
import { priorityLabel, statusLabel } from "../event-text";
import {
  CONVERSATION_PRIORITIES,
  type ConversationPriority,
  type ConversationStatus,
} from "../schemas";
import { allowedTransitions } from "../transitions";

type Member = { id: string; label: string };

type Props = {
  conversationId: string;
  status: ConversationStatus;
  priority: ConversationPriority;
  assigneeId: string | null;
  currentUserId: string;
  members: Member[];
  canUpdate: boolean;
  /** ADMIN and OWNER can assign anyone; members can only claim/release for themselves. */
  canAssignOthers: boolean;
};

/** Status, priority and assignment controls. Rules are enforced by the API; this only offers valid choices. */
export function ConversationControls(props: Props) {
  const {
    conversationId,
    status,
    priority,
    assigneeId,
    currentUserId,
    members,
    canUpdate,
    canAssignOthers,
  } = props;
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function run(request: Promise<{ ok: boolean; message?: string }>) {
    setBusy(true);
    setError(null);
    const result = await request;
    setBusy(false);
    if (!result.ok) {
      setError(result.message ?? "Update failed");
      return;
    }
    startTransition(() => router.refresh());
  }

  const patch = (body: Record<string, string>) =>
    run(apiRequest(`/api/conversations/${conversationId}`, { method: "PATCH", body }));
  const assign = (userId: string) =>
    run(
      apiRequest(`/api/conversations/${conversationId}/assign`, {
        method: "POST",
        body: { userId },
      }),
    );
  const unassign = () =>
    run(apiRequest(`/api/conversations/${conversationId}/unassign`, { method: "POST" }));

  const statuses: ConversationStatus[] = [status, ...allowedTransitions(status)];
  const mine = assigneeId === currentUserId;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Status" htmlFor="ctl-status">
          <NativeSelect
            id="ctl-status"
            value={status}
            disabled={!canUpdate || busy}
            onChange={(event) => patch({ status: event.target.value })}
            className="w-36"
          >
            {statuses.map((value) => (
              <option key={value} value={value}>
                {statusLabel(value)}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <Field label="Priority" htmlFor="ctl-priority">
          <NativeSelect
            id="ctl-priority"
            value={priority}
            disabled={!canUpdate || busy}
            onChange={(event) => patch({ priority: event.target.value })}
            className="w-32"
          >
            {CONVERSATION_PRIORITIES.map((value) => (
              <option key={value} value={value}>
                {priorityLabel(value)}
              </option>
            ))}
          </NativeSelect>
        </Field>

        {canAssignOthers ? (
          <Field label="Assignee" htmlFor="ctl-assignee">
            <NativeSelect
              id="ctl-assignee"
              value={assigneeId ?? ""}
              disabled={busy}
              onChange={(event) => (event.target.value ? assign(event.target.value) : unassign())}
              className="w-48"
            >
              <option value="">Unassigned</option>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Assignee</span>
            {mine ? (
              <Button variant="outline" size="sm" disabled={busy} onClick={unassign}>
                Unassign me
              </Button>
            ) : assigneeId === null ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => assign(currentUserId)}
              >
                Assign to me
              </Button>
            ) : (
              <span className="text-muted-foreground py-1.5 text-sm">
                {members.find((member) => member.id === assigneeId)?.label ?? "Another member"}
              </span>
            )}
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
