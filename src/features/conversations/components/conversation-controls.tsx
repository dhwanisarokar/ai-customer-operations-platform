"use client";

import { NativeSelect } from "@/components/shared/native-select";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ConversationJson } from "../api/types";
import { priorityLabel, statusLabel } from "../event-text";
import {
  useAssignConversation,
  useChangeConversationPriority,
  useChangeConversationStatus,
  useUnassignConversation,
  type Assignee,
} from "../hooks/mutations";
import { CONVERSATION_PRIORITIES, type ConversationStatus } from "../schemas";
import { allowedTransitions } from "../transitions";

type Member = { id: string; label: string; email: string; name: string | null };

type Props = {
  conversation: Pick<ConversationJson, "id" | "status" | "priority" | "assignee">;
  currentUserId: string;
  members: Member[];
  canUpdate: boolean;
  /** ADMIN and OWNER can assign anyone; members can only claim/release for themselves. */
  canAssignOthers: boolean;
};

/**
 * Status, priority and assignment. Every change is optimistic: the UI (header, inbox list) updates
 * immediately from the `conversation` the parent reads from TanStack Query, and rolls back with the
 * server's error message if the change is refused. The controls hold no copy of the server state.
 */
export function ConversationControls({
  conversation,
  currentUserId,
  members,
  canUpdate,
  canAssignOthers,
}: Props) {
  const status = useChangeConversationStatus();
  const priority = useChangeConversationPriority();
  const assign = useAssignConversation();
  const unassign = useUnassignConversation();

  const id = conversation.id;
  const statuses: ConversationStatus[] = [
    conversation.status,
    ...allowedTransitions(conversation.status),
  ];
  const assigneeId = conversation.assignee?.id ?? null;
  const mine = assigneeId === currentUserId;
  const error = status.error ?? priority.error ?? assign.error ?? unassign.error;

  const asAssignee = (member: Member): Assignee => ({
    id: member.id,
    name: member.name,
    email: member.email,
  });
  const me = members.find((member) => member.id === currentUserId);

  function resetErrors() {
    status.reset();
    priority.reset();
    assign.reset();
    unassign.reset();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Status" htmlFor="ctl-status">
          <NativeSelect
            id="ctl-status"
            value={conversation.status}
            disabled={!canUpdate}
            onChange={(event) => {
              resetErrors();
              status.mutate({
                conversationId: id,
                status: event.target.value as ConversationStatus,
              });
            }}
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
            value={conversation.priority}
            disabled={!canUpdate}
            onChange={(event) => {
              resetErrors();
              priority.mutate({
                conversationId: id,
                priority: event.target.value as (typeof CONVERSATION_PRIORITIES)[number],
              });
            }}
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
              onChange={(event) => {
                resetErrors();
                const member = members.find((candidate) => candidate.id === event.target.value);
                if (member) assign.mutate({ conversationId: id, assignee: asAssignee(member) });
                else unassign.mutate({ conversationId: id });
              }}
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resetErrors();
                  unassign.mutate({ conversationId: id });
                }}
              >
                Unassign me
              </Button>
            ) : assigneeId === null ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!me}
                onClick={() => {
                  resetErrors();
                  if (me) assign.mutate({ conversationId: id, assignee: asAssignee(me) });
                }}
              >
                Assign to me
              </Button>
            ) : (
              <span className="text-muted-foreground py-1.5 text-sm">
                {conversation.assignee?.name ?? conversation.assignee?.email}
              </span>
            )}
          </div>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
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
