"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/api-client";

export type PickedCustomer = { id: string; name: string; subtitle: string | null };

type CustomerItem = {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  company: string | null;
};

/**
 * Searches customers through the API (server-side search, 8 results) and reports the choice.
 * Archived customers are excluded by the API's default list.
 */
export function CustomerPicker({
  value,
  onChange,
  error,
}: {
  value: PickedCustomer | null;
  onChange: (customer: PickedCustomer | null) => void;
  error?: string;
}) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PickedCustomer[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");

  useEffect(() => {
    if (value || query.trim().length < 2) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      setState("loading");
      const result = await apiRequest<{ items: CustomerItem[] }>(
        `/api/customers?pageSize=8&q=${encodeURIComponent(query.trim())}`,
      );
      if (cancelled) return;
      if (!result.ok) {
        setState("error");
        return;
      }
      setResults(
        result.data.items.map((customer) => ({
          id: customer.id,
          name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
          subtitle: [customer.email, customer.company].filter(Boolean).join(" · ") || null,
        })),
      );
      setState("idle");
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, value]);

  if (value) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Customer</span>
        <div className="border-input flex items-center justify-between gap-2 rounded-lg border px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{value.name}</p>
            {value.subtitle ? (
              <p className="text-muted-foreground truncate text-xs">{value.subtitle}</p>
            ) : null}
          </div>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>Customer</Label>
      <Input
        id={inputId}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name, email or company"
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${inputId}-status`}
      />
      <div id={`${inputId}-status`} aria-live="polite" className="text-sm">
        {error ? <p className="text-destructive">{error}</p> : null}
        {state === "loading" ? <p className="text-muted-foreground">Searching...</p> : null}
        {state === "error" ? <p className="text-destructive">Unable to search customers.</p> : null}
        {state === "idle" && query.trim().length >= 2 && results.length === 0 ? (
          <p className="text-muted-foreground">No customers found.</p>
        ) : null}
      </div>
      {results.length > 0 && query.trim().length >= 2 ? (
        <ul className="border-border divide-border divide-y overflow-hidden rounded-lg border">
          {results.map((customer) => (
            <li key={customer.id}>
              <button
                type="button"
                onClick={() => onChange(customer)}
                className="hover:bg-muted focus-visible:bg-muted flex w-full flex-col px-3 py-2 text-left outline-none"
              >
                <span className="text-sm font-medium">{customer.name}</span>
                {customer.subtitle ? (
                  <span className="text-muted-foreground text-xs">{customer.subtitle}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
