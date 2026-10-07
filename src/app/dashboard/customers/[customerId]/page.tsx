import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AddNoteForm } from "@/features/customers/components/add-note-form";
import { ActivityTimeline } from "@/features/customers/components/activity-timeline";
import { ArchiveCustomerButton } from "@/features/customers/components/archive-customer-button";
import { CustomerStatusBadge } from "@/features/customers/components/customer-status-badge";
import { CustomerTagsManager } from "@/features/customers/components/customer-tags-manager";
import { fullName } from "@/features/customers/normalize";
import { formatDate, formatDateTime } from "@/lib/format";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { parseUuidParam } from "@/server/http/params";
import { listTags } from "@/server/services/customer-tags";
import { getCustomer360 } from "@/server/services/customers";

export const dynamic = "force-dynamic";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const ctx = await requirePageContext();
  const { customerId } = await params;

  let data: Awaited<ReturnType<typeof getCustomer360>>;
  try {
    data = await getCustomer360(ctx, parseUuidParam(customerId, "Customer"));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { customer, tags, recentActivities, notes, counts } = data;
  const organizationTags = ctx.can("tag_customers") ? await listTags(ctx) : [];
  const name = fullName(customer);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <Link
        href="/dashboard/customers"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; All customers
      </Link>

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
          {ctx.can("update_customers") ? (
            <Link
              href={`/dashboard/customers/${customer.id}/edit`}
              className={buttonVariants({ variant: "outline" })}
            >
              Edit
            </Link>
          ) : null}
          {ctx.can("archive_customers") && customer.status !== "ARCHIVED" ? (
            <ArchiveCustomerButton customerId={customer.id} customerName={name} />
          ) : null}
        </div>
      </header>

      {customer.status === "ARCHIVED" ? (
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

          <Card>
            <CardHeader>
              <CardTitle>Tags</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerTagsManager
                customerId={customer.id}
                tags={tags.map(({ id, name }) => ({ id, name }))}
                organizationTags={organizationTags.map(({ id, name }) => ({ id, name }))}
                canTag={ctx.can("tag_customers")}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Notes ({counts.notes})</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {ctx.can("add_customer_notes") ? <AddNoteForm customerId={customer.id} /> : null}
              {notes.length === 0 ? (
                <p className="text-muted-foreground text-sm">No notes yet.</p>
              ) : (
                <ul className="divide-border flex flex-col divide-y">
                  {notes.map((note) => (
                    <li key={note.id} className="flex flex-col gap-1 py-3 first:pt-0">
                      <p className="text-sm break-words whitespace-pre-wrap">{note.content}</p>
                      <p className="text-muted-foreground text-xs">
                        {note.author?.name ?? note.author?.email ?? "Former member"} &middot;{" "}
                        {formatDateTime(note.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader>
            <CardTitle>Timeline</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ActivityTimeline activities={recentActivities} />
            {counts.activities > recentActivities.length ? (
              <p className="text-muted-foreground text-xs">
                Showing the latest {recentActivities.length} of {counts.activities} activities.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-words">{value ?? "-"}</dd>
    </>
  );
}
