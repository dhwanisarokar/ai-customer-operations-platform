"use client";

import { CheckIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import {
  ACTION_CATALOG,
  OPERATOR_LABELS,
  TRIGGER_CATALOG,
  isActionName,
  isTriggerName,
  type Operator,
} from "@/server/automation/catalog";
import type { ExecutionResponse } from "../api/types";
import { conditionNote, displayValue, memberLabel } from "../display";
import { useAutomationExecution } from "../hooks/queries";
import { ExecutionStatusBadge } from "./execution-status-badge";

type ConditionResult = {
  field: string;
  operator: Operator;
  expected: string | number | null;
  actual?: unknown;
  passed: boolean;
};
type ActionRecord = {
  index: number;
  action: string;
  status: "completed" | "failed";
  note?: string;
  error?: { code: string; message: string };
};

function describeAction(
  type: string,
  input: Record<string, unknown>,
  names: Record<string, string>,
): string {
  if (!isActionName(type)) return type;
  const def = ACTION_CATALOG[type];
  const [key, value] = Object.entries(input)[0] ?? [];
  if (key === undefined) return def.label;
  // Member ids are shown as the member's name; the id itself stays what is stored.
  return `${def.label}: ${def.memberFields?.includes(key) ? memberLabel(value, names) : String(value)}`;
}

/** One run in full: the event, each condition's result and each action's outcome. */
export function ExecutionDetailView({
  automationId,
  executionId,
  initialData,
}: {
  automationId: string;
  executionId: string;
  initialData: ExecutionResponse;
}) {
  const { data, isPending, error } = useAutomationExecution(automationId, executionId, {
    initialData,
  });
  if (isPending) return <Skeleton className="h-64 w-full" aria-label="Loading execution" />;
  if (!data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>{error?.message ?? "Unable to load this run."}</AlertDescription>
      </Alert>
    );
  }

  const run = data.execution;
  const trigger = isTriggerName(run.eventType) ? TRIGGER_CATALOG[run.eventType] : undefined;
  const conditions = run.conditionResults as ConditionResult[];
  const records = run.actionResults as ActionRecord[];
  const names = run.memberNames;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-wrap items-center gap-3" aria-label="Summary">
        <ExecutionStatusBadge status={run.status} />
        <span className="text-muted-foreground text-sm">
          Started {formatDateTime(run.createdAt)}
          {run.completedAt ? ` · finished ${formatDateTime(run.completedAt)}` : ""}
          {` · ${run.attempts} attempt${run.attempts === 1 ? "" : "s"}`}
        </span>
      </section>

      {run.errorMessage ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>
            {run.errorMessage}
            {run.errorCode ? <span className="text-xs"> ({run.errorCode})</span> : null}
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Trigger" className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Trigger</h2>
        <p className="text-sm">{trigger?.label ?? run.eventType}</p>
        <p className="text-muted-foreground text-xs">Event {run.eventId}</p>
        <dl className="mt-1 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[max-content_1fr]">
          {Object.entries(run.eventData).map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-muted-foreground">{trigger?.fields[key]?.label ?? key}</dt>
              <dd
                className="break-all"
                title={trigger?.fields[key]?.ref === "member" ? String(value ?? "") : undefined}
              >
                {displayValue(trigger?.fields[key], value, names)}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-label="Conditions" className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Conditions</h2>
        {conditions.length === 0 ? (
          <p className="text-muted-foreground text-sm">None: it runs on every event.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conditions.map((condition, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <Mark ok={condition.passed} />
                <span className="break-words">
                  {trigger?.fields[condition.field]?.label ?? condition.field}{" "}
                  {OPERATOR_LABELS[condition.operator]}
                  {condition.expected !== null
                    ? ` “${displayValue(trigger?.fields[condition.field], condition.expected, names)}”`
                    : ""}
                  {(() => {
                    const note = conditionNote(trigger, condition, run.eventData, names);
                    return note ? <span className="text-muted-foreground"> ({note})</span> : null;
                  })()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Actions" className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold tracking-wide uppercase">Actions</h2>
        <ol className="flex flex-col gap-2">
          {run.definition.actions.map((action, index) => {
            const record = records.find((r) => r.index === index);
            return (
              <li key={index} className="flex items-start gap-2 text-sm">
                {record ? <Mark ok={record.status === "completed"} /> : <Pending />}
                <span className="break-words">
                  {describeAction(action.type, action.input, names)}
                  {record?.note ? (
                    <span className="text-muted-foreground"> — {record.note}</span>
                  ) : null}
                  {record?.error ? (
                    <span className="text-destructive block text-xs">
                      {record.error.message} ({record.error.code})
                    </span>
                  ) : null}
                  {!record ? <span className="text-muted-foreground"> — not run</span> : null}
                </span>
              </li>
            );
          })}
        </ol>
      </section>
    </div>
  );
}

function Mark({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckIcon className="text-primary mt-0.5 size-4 shrink-0" aria-label="Passed" role="img" />
  ) : (
    <XIcon className="text-destructive mt-0.5 size-4 shrink-0" aria-label="Failed" role="img" />
  );
}

function Pending() {
  return (
    <span
      className="text-muted-foreground mt-0.5 size-4 shrink-0 text-center"
      aria-label="Not run"
      role="img"
    >
      ·
    </span>
  );
}
