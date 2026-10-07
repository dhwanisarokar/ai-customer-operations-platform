"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest, type FieldErrors } from "@/lib/api-client";
import {
  createDocumentSchema,
  MAX_CONTENT_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_TITLE_LENGTH,
} from "../schemas";

type Values = { title: string; description: string; content: string };

type Props =
  | { mode: "create"; initialValues?: undefined; documentId?: undefined; live?: undefined }
  | {
      mode: "edit";
      initialValues: Values;
      documentId: string;
      /** True when saving re-indexes the document (it is published). */
      live: boolean;
    };

/** One form for creating and editing. Saving live content re-embeds it, which can take a moment. */
export function KnowledgeDocumentForm({ mode, initialValues, documentId, live }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Values>(
    initialValues ?? { title: "", description: "", content: "" },
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    const parsed = createDocumentSchema.safeParse(values);
    if (!parsed.success) {
      const next: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !next[key]) next[key] = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    setBusy(true);
    const result =
      mode === "create"
        ? await apiRequest<{ document: { id: string } }>("/api/knowledge", {
            method: "POST",
            body: values,
          })
        : await apiRequest(`/api/knowledge/${documentId}`, { method: "PATCH", body: values });
    setBusy(false);

    if (!result.ok) {
      setErrors(result.fieldErrors);
      setFormError(result.message);
      return;
    }
    const targetId =
      mode === "create" ? (result.data as { document: { id: string } }).document.id : documentId;
    startTransition(() => {
      router.push(`/dashboard/knowledge/${targetId}`);
      router.refresh();
    });
  }

  const set = (key: keyof Values) => (value: string) =>
    setValues((current) => ({ ...current, [key]: value }));

  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <Field id="kb-title" label="Title" error={errors.title}>
        <Input
          id="kb-title"
          value={values.title}
          onChange={(event) => set("title")(event.target.value)}
          maxLength={MAX_TITLE_LENGTH}
          aria-invalid={errors.title ? true : undefined}
          aria-describedby={errors.title ? "kb-title-error" : undefined}
        />
      </Field>

      <Field id="kb-description" label="Description (optional)" error={errors.description}>
        <Input
          id="kb-description"
          value={values.description}
          onChange={(event) => set("description")(event.target.value)}
          maxLength={MAX_DESCRIPTION_LENGTH}
          aria-describedby={errors.description ? "kb-description-error" : undefined}
        />
      </Field>

      <Field id="kb-content" label="Content" error={errors.content}>
        <Textarea
          id="kb-content"
          value={values.content}
          onChange={(event) => set("content")(event.target.value)}
          rows={16}
          maxLength={MAX_CONTENT_LENGTH}
          className="font-mono text-sm"
          aria-invalid={errors.content ? true : undefined}
          aria-describedby={errors.content ? "kb-content-error" : undefined}
        />
        <p className="text-muted-foreground text-xs">
          {values.content.length.toLocaleString()} / {MAX_CONTENT_LENGTH.toLocaleString()}{" "}
          characters. Separate topics with blank lines; the AI searches this text in short passages.
        </p>
      </Field>

      {live ? (
        <p className="text-muted-foreground text-sm">
          This document is published. Saving re-indexes it, which can take a few seconds. If
          indexing fails, nothing is changed.
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>
          {busy
            ? live
              ? "Saving and indexing..."
              : "Saving..."
            : mode === "create"
              ? "Create draft"
              : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
