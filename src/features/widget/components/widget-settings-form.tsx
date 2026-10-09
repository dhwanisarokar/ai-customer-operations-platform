"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ApiError, fetchJson } from "@/lib/api-client";
import { widgetKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";

export type WidgetSettingsJson = {
  publicKey: string;
  enabled: boolean;
  displayName: string;
  welcomeMessage: string;
  accentColor: string | null;
  allowedOrigins: string[];
  aiRepliesEnabled: boolean;
};

type Response = { settings: WidgetSettingsJson };

export function embedSnippet(origin: string, publicKey: string): string {
  return `<script src="${origin}/widget.js" data-key="${publicKey}" async></script>`;
}

export function WidgetSettingsForm({ origin }: { origin?: string }) {
  const org = useOrganizationScope();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: widgetKeys.settings(org),
    queryFn: ({ signal }) => fetchJson<Response>("/api/widget-settings", { signal }),
  });
  const save = useMutation({
    mutationFn: (settings: Omit<WidgetSettingsJson, "publicKey">) =>
      fetchJson<Response>("/api/widget-settings", { method: "PUT", body: settings }),
    onSuccess: (data) => queryClient.setQueryData(widgetKeys.settings(org), data),
  });

  if (query.isPending) return <p className="text-muted-foreground text-sm">Loading settings…</p>;
  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {query.error instanceof ApiError && query.error.status === 403
            ? "Only admins can manage the web chat widget."
            : "Could not load the widget settings."}
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <SettingsFields
      key={JSON.stringify(query.data.settings)}
      settings={query.data.settings}
      origin={origin ?? (typeof window === "undefined" ? "" : window.location.origin)}
      saving={save.isPending}
      error={save.error instanceof ApiError ? save.error : null}
      saved={save.isSuccess}
      onSave={(values) => save.mutate(values)}
    />
  );
}

function SettingsFields({
  settings,
  origin,
  saving,
  error,
  saved,
  onSave,
}: {
  settings: WidgetSettingsJson;
  origin: string;
  saving: boolean;
  error: ApiError | null;
  saved: boolean;
  onSave: (values: Omit<WidgetSettingsJson, "publicKey">) => void;
}) {
  const [enabled, setEnabled] = useState(settings.enabled);
  const [displayName, setDisplayName] = useState(settings.displayName);
  const [welcomeMessage, setWelcomeMessage] = useState(settings.welcomeMessage);
  const [accentColor, setAccentColor] = useState(settings.accentColor ?? "");
  const [origins, setOrigins] = useState(settings.allowedOrigins.join("\n"));
  const [aiRepliesEnabled, setAiRepliesEnabled] = useState(settings.aiRepliesEnabled);

  const fieldError = (name: string) => error?.fieldErrors[name] ?? null;

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          enabled,
          aiRepliesEnabled,
          displayName,
          welcomeMessage,
          accentColor: accentColor.trim() === "" ? null : accentColor.trim(),
          allowedOrigins: origins
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean),
        });
      }}
    >
      <label className="flex items-center gap-2 text-sm font-medium">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          className="size-4"
        />
        Enable the chat widget
      </label>

      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={aiRepliesEnabled}
            onChange={(event) => setAiRepliesEnabled(event.target.checked)}
            className="size-4"
          />
          Answer visitors automatically with AI
        </label>
        <p className="text-muted-foreground text-xs">
          The assistant answers from your published knowledge only. It cannot change anything and
          stops as soon as a person is assigned, replies, or the visitor asks for one.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="widget-name">Name shown in the widget</Label>
        <Input
          id="widget-name"
          value={displayName}
          maxLength={60}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        {fieldError("displayName") ? (
          <p className="text-destructive text-sm">{fieldError("displayName")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="widget-welcome">Welcome message</Label>
        <Textarea
          id="widget-welcome"
          value={welcomeMessage}
          maxLength={500}
          onChange={(event) => setWelcomeMessage(event.target.value)}
        />
        {fieldError("welcomeMessage") ? (
          <p className="text-destructive text-sm">{fieldError("welcomeMessage")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="widget-color">Accent color (optional)</Label>
        <Input
          id="widget-color"
          value={accentColor}
          placeholder="#0f766e"
          onChange={(event) => setAccentColor(event.target.value)}
        />
        {fieldError("accentColor") ? (
          <p className="text-destructive text-sm">{fieldError("accentColor")}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="widget-origins">Allowed websites (one per line, optional)</Label>
        <Textarea
          id="widget-origins"
          value={origins}
          placeholder="https://www.example.com"
          onChange={(event) => setOrigins(event.target.value)}
        />
        <p className="text-muted-foreground text-xs">
          Leave empty to allow any website. When set, only these sites can show the chat. This
          limits where the widget is embedded; it is not a security boundary on its own.
        </p>
        {error && !error.fieldErrors.displayName && !error.fieldErrors.welcomeMessage ? (
          <p className="text-destructive text-sm">{error.message}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="widget-snippet">Install on your website</Label>
        <Textarea
          id="widget-snippet"
          readOnly
          rows={2}
          value={embedSnippet(origin, settings.publicKey)}
          className="font-mono text-xs"
        />
        <p className="text-muted-foreground text-xs">
          Paste this before the closing &lt;/body&gt; tag. The key is public; it only identifies
          your organization.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
        {saved && !error ? <span className="text-muted-foreground text-sm">Saved.</span> : null}
      </div>
    </form>
  );
}
