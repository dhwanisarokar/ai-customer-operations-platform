"use client";

import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDateTime } from "@/lib/format";
import { TRIGGER_CATALOG, isTriggerName } from "@/server/automation/catalog";
import type { AutomationListResponse } from "../api/types";
import { useSetAutomationEnabled } from "../hooks/mutations";
import { useAutomations } from "../hooks/queries";

export function AutomationListView({
  initialData,
  canCreate,
  canUpdate,
}: {
  initialData: AutomationListResponse;
  canCreate: boolean;
  canUpdate: boolean;
}) {
  const { data, isPending, error, refetch } = useAutomations({ initialData });
  const toggle = useSetAutomationEnabled();

  if (isPending) {
    return (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading automations">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <Alert variant="destructive">
          <AlertDescription>{error?.message ?? "Unable to load automations."}</AlertDescription>
        </Alert>
        <Button variant="outline" className="self-start" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (data.items.length === 0) {
    return (
      <EmptyState
        title="No automations yet"
        description="Automations run actions for you when something happens, such as tagging and assigning urgent conversations."
        action={
          canCreate ? (
            <Link href="/dashboard/automations/new" className={buttonVariants()}>
              New automation
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {toggle.error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{toggle.error.message}</AlertDescription>
        </Alert>
      ) : null}
      <ul className="border-border bg-card divide-border divide-y overflow-hidden rounded-xl border">
        {data.items.map((automation) => (
          <li key={automation.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <Link
                href={`/dashboard/automations/${automation.id}`}
                className="font-medium break-words underline-offset-4 hover:underline"
              >
                {automation.name}
              </Link>
              <p className="text-muted-foreground text-sm break-words">
                When{" "}
                {isTriggerName(automation.trigger)
                  ? TRIGGER_CATALOG[automation.trigger].label.toLowerCase()
                  : automation.trigger}
                {" · "}
                {automation.actions.length} action{automation.actions.length === 1 ? "" : "s"}
                {" · created "}
                {formatDateTime(automation.createdAt)}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={automation.enabled ? "default" : "outline"}>
                {automation.enabled ? "Enabled" : "Disabled"}
              </Badge>
              {canUpdate ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate({ id: automation.id, enabled: !automation.enabled })}
                  aria-label={`${automation.enabled ? "Disable" : "Enable"} ${automation.name}`}
                >
                  {automation.enabled ? "Disable" : "Enable"}
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
