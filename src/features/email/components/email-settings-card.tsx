"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError, fetchJson } from "@/lib/api-client";
import { MAX_FROM_NAME_LENGTH } from "../schemas";

/** Mirrors `EmailSettingsDto` (server). Nothing here is a secret or comes from another organization. */
export type EmailSettingsJson = {
  available: boolean;
  platformDomain: string | null;
  enabled: boolean;
  status: "UNCONFIGURED" | "PENDING_VERIFICATION" | "ACTIVE" | "FAILED";
  statusDetail: string | null;
  localPart: string | null;
  supportAddress: string | null;
  fromName: string | null;
  suggestedLocalPart: string;
};
type Response = { settings: EmailSettingsJson };

const KEY = ["staff", "email-settings"] as const;

const STATUS_LABEL: Record<EmailSettingsJson["status"], string> = {
  UNCONFIGURED: "Not set up",
  PENDING_VERIFICATION: "Waiting for verification",
  ACTIVE: "Verified",
  FAILED: "Verification failed",
};

/**
 * Email channel settings (staff, `manage_email`): choose the support address on the platform's email
 * domain, verify it with the provider, then turn the channel on. Disabled by default; the server decides
 * everything (this view only mirrors its answers).
 */
export function EmailSettingsCard() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchJson<Response>("/api/email-settings", { signal }),
  });
  const accept = (data: Response) => queryClient.setQueryData(KEY, data);

  const save = useMutation({
    mutationFn: (input: { localPart: string; fromName: string }) =>
      fetchJson<Response>("/api/email-settings", { method: "PUT", body: input }),
    onSuccess: accept,
  });
  const verify = useMutation({
    mutationFn: () => fetchJson<Response>("/api/email-settings/verify", { method: "POST" }),
    onSuccess: accept,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) =>
      fetchJson<Response>("/api/email-settings/enabled", { method: "PUT", body: { enabled } }),
    onSuccess: accept,
  });

  if (query.isPending) {
    return <p className="text-muted-foreground text-sm">Loading email settings…</p>;
  }
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 403) return null;
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center gap-3">
          <span>Could not load the email settings.</span>
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const settings = query.data.settings;
  const error = [save.error, verify.error, toggle.error].find((e) => e instanceof ApiError) as
    ApiError | undefined;

  return (
    <section
      aria-label="Email channel"
      className="border-border flex flex-col gap-3 rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Email</h2>
        <Badge variant={settings.status === "ACTIVE" ? "default" : "secondary"}>
          {STATUS_LABEL[settings.status]}
        </Badge>
        {settings.enabled ? <Badge>On</Badge> : <Badge variant="outline">Off</Badge>}
      </div>
      <p className="text-muted-foreground text-sm">
        Customers who email your support address appear in the Inbox, and your team replies from
        there. Plain text only; attachments are not downloaded.
      </p>

      {!settings.available ? (
        <p role="status" className="text-muted-foreground text-sm">
          Email is not available on this platform yet. The platform needs an email provider and a
          domain before an address can be set up.
        </p>
      ) : (
        <>
          {/* Re-mounted when the saved values change so the fields show what the server holds. */}
          <AddressForm
            key={`${settings.localPart}|${settings.fromName}`}
            settings={settings}
            saving={save.isPending}
            onSave={(input) => {
              verify.reset();
              toggle.reset();
              save.mutate(input);
            }}
          />

          {settings.supportAddress ? (
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                disabled={verify.isPending}
                onClick={() => {
                  save.reset();
                  toggle.reset();
                  verify.mutate();
                }}
              >
                {verify.isPending
                  ? "Verifying…"
                  : settings.status === "ACTIVE"
                    ? "Verify again"
                    : "Verify address"}
              </Button>
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={settings.enabled}
                  disabled={toggle.isPending || (settings.status !== "ACTIVE" && !settings.enabled)}
                  onChange={(event) => toggle.mutate(event.target.checked)}
                />
                Turn email on
              </label>
              {settings.status !== "ACTIVE" ? (
                <span className="text-muted-foreground text-xs">Verify the address first.</span>
              ) : null}
            </div>
          ) : null}

          {settings.status === "FAILED" ? (
            <p role="alert" className="text-destructive text-sm">
              The provider could not confirm this address
              {settings.statusDetail ? ` (${settings.statusDetail})` : ""}. Try again or choose a
              different name.
            </p>
          ) : null}
        </>
      )}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      ) : null}
    </section>
  );
}

function AddressForm({
  settings,
  saving,
  onSave,
}: {
  settings: EmailSettingsJson;
  saving: boolean;
  onSave: (input: { localPart: string; fromName: string }) => void;
}) {
  const [localPart, setLocalPart] = useState(settings.localPart ?? settings.suggestedLocalPart);
  const [fromName, setFromName] = useState(settings.fromName ?? "");

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ localPart: localPart.trim(), fromName: fromName.trim() });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email-local">Support address</Label>
        <div className="flex items-center gap-2">
          <Input
            id="email-local"
            value={localPart}
            maxLength={32}
            className="max-w-48"
            onChange={(event) => setLocalPart(event.target.value)}
          />
          <span className="text-muted-foreground text-sm">@{settings.platformDomain}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="email-from-name">Sender name</Label>
        <Input
          id="email-from-name"
          value={fromName}
          maxLength={MAX_FROM_NAME_LENGTH}
          placeholder="Acme Support"
          onChange={(event) => setFromName(event.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={saving || !localPart.trim() || !fromName.trim()}
      >
        {saving ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
