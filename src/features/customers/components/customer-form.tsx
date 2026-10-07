"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";
import { NativeSelect } from "@/components/shared/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest, type FieldErrors } from "@/lib/api-client";
import { createCustomerSchema } from "../schemas";

export type CustomerFormValues = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  company: string;
  jobTitle: string;
  source: string;
  status: "ACTIVE" | "INACTIVE";
};

const EMPTY: CustomerFormValues = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  company: "",
  jobTitle: "",
  source: "",
  status: "ACTIVE",
};

type Props =
  | { mode: "create"; initialValues?: undefined; customerId?: undefined }
  | { mode: "edit"; initialValues: CustomerFormValues; customerId: string };

/** One form for both creating and editing; mode only changes the request and the redirect. */
export function CustomerForm({ mode, initialValues, customerId }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<CustomerFormValues>(initialValues ?? EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();

  function set<K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);

    // Same schema the server uses, so the browser shows identical field messages.
    const parsed = createCustomerSchema.safeParse(values);
    if (!parsed.success) {
      const fieldErrors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? "");
        if (key && !fieldErrors[key]) fieldErrors[key] = issue.message;
      }
      setErrors(fieldErrors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    const result =
      mode === "create"
        ? await apiRequest<{ customer: { id: string } }>("/api/customers", {
            method: "POST",
            body: values,
          })
        : await apiRequest(`/api/customers/${customerId}`, { method: "PATCH", body: values });
    setSubmitting(false);

    if (!result.ok) {
      setErrors(result.fieldErrors);
      setFormError(result.message);
      return;
    }
    const targetId =
      mode === "create" ? (result.data as { customer: { id: string } }).customer.id : customerId;
    startTransition(() => {
      router.push(`/dashboard/customers/${targetId}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" noValidate>
      {formError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{formError}</AlertDescription>
        </Alert>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          id="firstName"
          label="First name"
          required
          values={values}
          errors={errors}
          set={set}
          autoComplete="given-name"
        />
        <TextField
          id="lastName"
          label="Last name"
          values={values}
          errors={errors}
          set={set}
          autoComplete="family-name"
        />
        <TextField
          id="email"
          label="Email"
          type="email"
          values={values}
          errors={errors}
          set={set}
          autoComplete="email"
        />
        <TextField
          id="phone"
          label="Phone"
          type="tel"
          values={values}
          errors={errors}
          set={set}
          autoComplete="tel"
        />
        <TextField
          id="company"
          label="Company"
          values={values}
          errors={errors}
          set={set}
          autoComplete="organization"
        />
        <TextField
          id="jobTitle"
          label="Job title"
          values={values}
          errors={errors}
          set={set}
          autoComplete="organization-title"
        />
        <TextField
          id="source"
          label="Source"
          placeholder="e.g. website, referral"
          values={values}
          errors={errors}
          set={set}
        />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="status">Status</Label>
          <NativeSelect
            id="status"
            value={values.status}
            onChange={(event) => set("status", event.target.value as CustomerFormValues["status"])}
          >
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </NativeSelect>
        </div>
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting}>
          {submitting ? "Saving..." : mode === "create" ? "Create customer" : "Save changes"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => router.back()} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TextField({
  id,
  label,
  values,
  errors,
  set,
  required,
  type = "text",
  placeholder,
  autoComplete,
}: {
  id: Exclude<keyof CustomerFormValues, "status">;
  label: string;
  values: CustomerFormValues;
  errors: FieldErrors;
  set: <K extends keyof CustomerFormValues>(key: K, value: CustomerFormValues[K]) => void;
  required?: boolean;
  type?: string;
  placeholder?: string;
  autoComplete?: string;
}) {
  const error = errors[id];
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </Label>
      <Input
        id={id}
        name={id}
        type={type}
        value={values[id]}
        onChange={(event) => set(id, event.target.value)}
        required={required}
        placeholder={placeholder}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
      />
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
