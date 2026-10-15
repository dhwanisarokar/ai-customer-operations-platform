"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ApiError, fetchJson } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { inboxHref } from "@/features/conversations/inbox-params";
import type { AttentionCategory, AttentionPage } from "@/server/email/outbound-ops";

type Page = Omit<AttentionPage, "items"> & {
  items: (Omit<AttentionPage["items"][number], "since"> & { since: string })[];
};
type Recheck = { outcome: "found" | "no_record" | "unavailable" | "inconclusive" };

const KEY = ["staff", "email-attention"] as const;
const PAGE_SIZE = 10;

const LABEL: Record<AttentionCategory, string> = {
  queued_overdue: "Waiting to send, overdue",
  retry_overdue: "Retry overdue",
  lease_expired: "Stalled while sending",
  unknown: "Outcome unknown",
  failed: "Failed",
};

const HELP: Record<AttentionCategory, string> = {
  queued_overdue: "It should have been picked up by now. The background worker may be stopped.",
  retry_overdue: "A scheduled retry is late. The background worker may be stopped.",
  lease_expired:
    "The worker handling it stopped. It is recovered automatically once a worker runs.",
  unknown:
    "The mail provider may or may not have accepted it. It is never resent automatically. Do not send it again before checking.",
  failed: "It was not sent.",
};

const RECHECK_TEXT: Record<Recheck["outcome"], string> = {
  found: "The provider has it: recorded as accepted by the provider.",
  no_record: "The provider has no record of it: recorded as not sent.",
  unavailable: "The provider could not answer. It stays unknown.",
  inconclusive:
    "The provider has no record, but it is too long ago for that to prove anything. It stays unknown.",
};

/**
 * Outbound email that needs attention, for the signed-in organization only (owners and admins). Only OVERDUE, stalled,
 * unknown and failed sends are listed: email that is queued or waiting for a scheduled retry is normal and is not shown.
 * Recipients are masked; there is no resend and no way to mark anything sent. The one action, "Check with provider", asks
 * the provider and records its answer.
 */
export function EmailAttentionCard() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: [...KEY, page],
    queryFn: ({ signal }) =>
      fetchJson<Page>(`/api/email-outbound/attention?page=${page}&pageSize=${PAGE_SIZE}`, {
        signal,
      }),
  });
  const recheck = useMutation({
    mutationFn: (id: string) =>
      fetchJson<Recheck>(`/api/email-outbound/${id}/recheck`, { method: "POST" }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEY }),
  });

  if (query.isPending)
    return <p className="text-muted-foreground text-sm">Loading email delivery...</p>;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) return null;
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>Could not load email delivery.</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const data = query.data;
  const totalPending = Object.values(data.summary).reduce((a, b) => a + b, 0);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const failure = recheck.error instanceof ApiError ? recheck.error.message : null;

  return (
    <section
      aria-label="Email delivery needing attention"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Email delivery</h2>
        {totalPending === 0 ? (
          <Badge variant="secondary">Nothing needs attention</Badge>
        ) : (
          (Object.keys(LABEL) as AttentionCategory[])
            .filter((category) => data.summary[category] > 0)
            .map((category) => (
              <Badge
                key={category}
                variant={
                  category === "unknown" || category === "failed" ? "destructive" : "secondary"
                }
              >
                {LABEL[category]}: {data.summary[category]}
              </Badge>
            ))
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Only email that is overdue, stalled, unknown or failed is listed. Email that is queued or
        waiting for a scheduled retry is normal and is not shown. Recipients are partly hidden.
      </p>

      {data.items.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Emails needing attention">
          {data.items.map((item) => (
            <li
              key={item.id}
              className="border-border flex flex-col gap-1 rounded-lg border p-3 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={
                    item.category === "unknown" || item.category === "failed"
                      ? "destructive"
                      : "secondary"
                  }
                >
                  {LABEL[item.category]}
                </Badge>
                <span className="text-muted-foreground">to {item.recipient}</span>
                <span className="text-muted-foreground">since {formatDateTime(item.since)}</span>
                <Link
                  href={inboxHref({}, { c: item.conversationId })}
                  className="ml-auto text-xs underline underline-offset-2"
                >
                  Open conversation
                </Link>
              </div>
              <p className="text-muted-foreground text-xs">{HELP[item.category]}</p>
              {item.category === "unknown" ? (
                item.canRecheck ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={recheck.isPending}
                      onClick={() => recheck.mutate(item.id)}
                    >
                      Check with provider
                    </Button>
                    {recheck.isSuccess && recheck.variables === item.id ? (
                      <span role="status" className="text-xs">
                        {RECHECK_TEXT[recheck.data.outcome]}
                      </span>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    The mail provider cannot be asked about this email, so it stays unknown until
                    the provider confirms it.
                  </p>
                )
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {failure ? (
        <p role="alert" className="text-destructive text-sm">
          {failure}
        </p>
      ) : null}

      {pages > 1 ? (
        <div className="flex items-center justify-between text-sm">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </Button>
          <span className="text-muted-foreground">
            Page {data.page} of {pages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}
    </section>
  );
}
