"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ApiError, fetchJson } from "@/lib/api-client";

/** Staff-side controls of the customer portal. The server enforces `manage_portal` on every call. */

type Settings = { enabled: boolean; slug: string };

export function PortalSettingsCard({ origin }: { origin?: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["staff", "portal-settings"],
    queryFn: ({ signal }) => fetchJson<{ settings: Settings }>("/api/portal-settings", { signal }),
  });
  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchJson<{ settings: Settings }>("/api/portal-settings", {
        method: "PUT",
        body: { enabled },
      }),
    onSuccess: (data) => queryClient.setQueryData(["staff", "portal-settings"], data),
  });

  if (query.isPending) return <p className="text-muted-foreground text-sm">Loading…</p>;
  if (query.isError) return null; // not allowed (or unavailable): nothing to configure here
  const { enabled, slug } = query.data.settings;
  const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);

  return (
    <section
      aria-label="Customer portal"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h2 className="text-lg font-semibold">Customer portal</h2>
      <p className="text-muted-foreground text-sm">
        A signed-in area where invited customers follow their own conversations, search the help
        center and edit their name and phone. Customers get access only through an invitation you
        send from their customer page.
      </p>
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          className="size-4"
          checked={enabled}
          disabled={save.isPending}
          onChange={(event) => save.mutate(event.target.checked)}
        />
        Enable the customer portal
      </label>
      {enabled ? (
        <p className="text-muted-foreground text-xs">
          Portal address: <span className="font-mono">{`${base}/portal/${slug}`}</span>
        </p>
      ) : null}
      {save.isError ? (
        <p role="alert" className="text-destructive text-sm">
          Could not save.
        </p>
      ) : null}
    </section>
  );
}

type Access = { linked: boolean; linkedAt: string | null; pendingInvites: number };

export function PortalAccessCard({ customerId, origin }: { customerId: string; origin?: string }) {
  const queryClient = useQueryClient();
  const key = ["staff", "portal-access", customerId];
  const [link, setLink] = useState<string | null>(null);
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      fetchJson<{ access: Access }>(`/api/customers/${customerId}/portal-access`, { signal }),
  });
  const invite = useMutation({
    mutationFn: () =>
      fetchJson<{ invite: { joinPath: string; expiresAt: string } }>(
        `/api/customers/${customerId}/portal-invite`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      const base = origin ?? (typeof window === "undefined" ? "" : window.location.origin);
      setLink(`${base}${data.invite.joinPath}`);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      fetchJson<{ removed: boolean }>(`/api/customers/${customerId}/portal-access`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setLink(null);
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  if (query.isPending) return null;
  if (query.isError) return null; // not allowed or unavailable
  const access = query.data.access;
  const error =
    (invite.error ?? revoke.error) instanceof ApiError ? (invite.error ?? revoke.error) : null;

  return (
    <section
      aria-label="Portal access"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <h2 className="text-lg font-semibold">Customer portal access</h2>
      {access.linked ? (
        <>
          <p className="text-sm">This customer can sign in to the portal.</p>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            Revoke access
          </Button>
        </>
      ) : (
        <>
          <p className="text-muted-foreground text-sm">
            Send this customer an invitation. They must sign in with their verified email address
            (the one on this record) to accept it. Invitations work once and expire after 7 days.
            {access.pendingInvites > 0 ? ` ${access.pendingInvites} invitation pending.` : ""}
          </p>
          <Button
            size="sm"
            className="self-start"
            disabled={invite.isPending}
            onClick={() => invite.mutate()}
          >
            {invite.isPending ? "Creating…" : "Create invitation link"}
          </Button>
        </>
      )}
      {link ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="portal-invite-link" className="text-xs font-medium">
            Invitation link (shown once)
          </label>
          <input
            id="portal-invite-link"
            readOnly
            value={link}
            className="border-input bg-background rounded-md border px-2 py-1 font-mono text-xs"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
