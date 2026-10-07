"use client";

import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerConversations } from "@/features/conversations/components/customer-conversations";
import { formatDate, formatDateTime } from "@/lib/format";
import { DEFAULT_ACTIVITIES_PARAMS, DEFAULT_NOTES_PARAMS } from "../api/requests";
import type { Customer360Response, OrganizationTagsResponse } from "../api/types";
import { useCustomer, useCustomerActivities } from "../hooks/queries";
import { fullName } from "../normalize";
import { ActivityTimeline } from "./activity-timeline";
import { ArchiveCustomerButton } from "./archive-customer-button";
import { CustomerNotes } from "./customer-notes";
import { CustomerStatusBadge } from "./customer-status-badge";
import { CustomerTagsManager } from "./customer-tags-manager";

type Props = {
  customerId: string;
  /** The Customer 360 fetched on the server for first paint. */
  initial: Customer360Response;
  initialOrganizationTags: OrganizationTagsResponse;
  /** UI hints computed by the server. The API enforces every permission regardless. */
  can: {
    update: boolean;
    archive: boolean;
    tag: boolean;
    addNotes: boolean;
    viewConversations: boolean;
    createConversations: boolean;
  };
};

/**
 * Customer 360. Each section reads its own query (customer, tags, notes, activities); none keeps a
 * private copy of server data, so a mutation only has to update or invalidate the query it affects.
 */
export function CustomerDetailView({ customerId, initial, initialOrganizationTags, can }: Props) {
  const detail = useCustomer(customerId, { initialData: initial });
  const activities = useCustomerActivities(customerId, DEFAULT_ACTIVITIES_PARAMS, {
    initialData: pageOf(
      initial.recentActivities,
      initial.counts.activities,
      DEFAULT_ACTIVITIES_PARAMS.pageSize,
    ),
  });

  const data = detail.data;
  if (!data) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertDescription>
          {detail.error?.message ?? "Unable to load this customer."}
        </AlertDescription>
      </Alert>
    );
  }

  const { customer, conversations, counts } = data;
  const name = fullName(customer);
  const archived = customer.status === "ARCHIVED";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
            <CustomerStatusBadge status={customer.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {[customer.email, customer.company].filter(Boolean).join(" · ") || "No contact details"}
          </p>
        </div>
        <div className="flex gap-2">
          {can.update ? (
            <Link
              href={`/dashboard/customers/${customer.id}/edit`}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
          ) : null}
          {can.archive && !archived ? (
            <ArchiveCustomerButton customerId={customer.id} customerName={name} />
          ) : null}
        </div>
      </header>

      {archived ? (
        <Alert>
          <AlertDescription>
            This customer was archived
            {customer.archivedAt ? ` on ${formatDate(customer.archivedAt)}` : ""}. Edit the customer
            and set the status to active to restore them.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Profile</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <Row label="Email" value={customer.email} />
                <Row label="Phone" value={customer.phone} />
                <Row label="Company" value={customer.company} />
                <Row label="Job title" value={customer.jobTitle} />
                <Row label="Source" value={customer.source} />
                <Row label="External ID" value={customer.externalId} />
                <Row label="Created" value={formatDate(customer.createdAt)} />
                <Row label="Updated" value={formatDateTime(customer.updatedAt)} />
              </dl>
            </CardContent>
          </Card>

          {can.viewConversations ? (
            <CustomerConversations
              customerId={customer.id}
              conversations={conversations}
              total={counts.conversations}
              canCreate={can.createConversations && !archived}
            />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerTagsManager
                customerId={customer.id}
                initialTags={{ tags: initial.tags }}
                initialOrganizationTags={initialOrganizationTags}
                canTag={can.tag}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerNotes
                customerId={customer.id}
                initialNotes={pageOf(
                  initial.notes,
                  initial.counts.notes,
                  DEFAULT_NOTES_PARAMS.pageSize,
                )}
                canAdd={can.addNotes}
              />
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ActivityTimeline activities={activities.data?.items ?? []} />
            {activities.data && activities.data.total > activities.data.items.length ? (
              <p className="text-muted-foreground text-xs">
                Showing the latest {activities.data.items.length} of {activities.data.total}{" "}
                activities.
              </p>
            ) : null}
            {activities.isError ? (
              <div role="alert" className="flex items-center gap-2 text-sm">
                <span className="text-destructive">Could not refresh the timeline.</span>
                <Button size="xs" variant="outline" onClick={() => activities.refetch()}>
                  Retry
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** The 360 payload embeds page 1 of notes/activities; this reshapes it into the paginated API shape. */
function pageOf<T>(items: T[], total: number, pageSize: number) {
  return { items, page: 1, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value ?? "-"}</dd>
    </>
  );
}
