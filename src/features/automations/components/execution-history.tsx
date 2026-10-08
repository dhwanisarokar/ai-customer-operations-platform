"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { TRIGGER_CATALOG, isTriggerName } from "@/server/automation/catalog";
import type { ExecutionListResponse } from "../api/types";
import { useAutomationExecutions } from "../hooks/queries";
import { ExecutionStatusBadge } from "./execution-status-badge";

/** Recent runs of one automation. Refreshes by itself while a run is queued or running. */
export function ExecutionHistory({
  automationId,
  initialData,
}: {
  automationId: string;
  initialData: ExecutionListResponse;
}) {
  const { data, isPending, error } = useAutomationExecutions(automationId, { initialData });

  if (isPending) return <Skeleton className="h-24 w-full" aria-label="Loading executions" />;
  if (!data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          {error?.message ?? "Unable to load the execution history."}
        </AlertDescription>
      </Alert>
    );
  }
  if (data.items.length === 0) {
    return (
      <EmptyState
        title="No runs yet"
        description="When an event matches this automation, each run shows up here with its result."
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="border-border bg-card divide-border divide-y overflow-hidden rounded-xl border">
        {data.items.map((run) => (
          <li key={run.id}>
            <Link
              href={`/dashboard/automations/${automationId}/executions/${run.id}`}
              className="hover:bg-muted/60 flex flex-wrap items-center justify-between gap-3 px-4 py-3"
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">
                  {isTriggerName(run.eventType)
                    ? TRIGGER_CATALOG[run.eventType].label
                    : run.eventType}
                </span>
                <span className="text-muted-foreground text-xs">
                  {formatDateTime(run.createdAt)}
                  {run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}
                </span>
                {run.errorMessage ? (
                  <span className="text-destructive text-xs break-words">{run.errorMessage}</span>
                ) : null}
              </span>
              <ExecutionStatusBadge status={run.status} />
            </Link>
          </li>
        ))}
      </ul>
      {data.total > data.items.length ? (
        <p className="text-muted-foreground text-xs">
          Showing the latest {data.items.length} of {data.total} runs.
        </p>
      ) : null}
    </div>
  );
}
