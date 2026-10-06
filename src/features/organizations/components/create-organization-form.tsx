"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function CreateOrganizationForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "");
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/organizations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? "Could not create the organization.");
        return;
      }
      form.reset();
      startTransition(() => router.refresh());
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  const busy = submitting || pending;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3" noValidate>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="organization-name">Organization name</Label>
        <Input
          id="organization-name"
          name="name"
          required
          maxLength={100}
          placeholder="Acme Inc"
          autoComplete="organization"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "organization-name-error" : undefined}
        />
        {error ? (
          <p id="organization-name-error" role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
      </div>
      <Button type="submit" disabled={busy} className="self-start">
        {busy ? "Creating..." : "Create organization"}
      </Button>
    </form>
  );
}
