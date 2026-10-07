"use client";

import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCustomers } from "@/features/customers/hooks/queries";
import { listCustomersQuerySchema } from "@/features/customers/schemas";
import { useDebouncedValue } from "@/hooks/use-debounced-value";

export type PickedCustomer = { id: string; name: string; subtitle: string | null };

/**
 * Searches customers through the same cached customer-list query the customers page uses (so
 * results are shared and cached), debounced so typing does not send a request per keystroke.
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
  const [text, setText] = useState("");
  const search = useDebouncedValue(text.trim(), 250);
  const enabled = !value && search.length >= 2;

  const results = useCustomers(listCustomersQuerySchema.parse({ q: search, pageSize: "8" }), {
    enabled,
  });

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

  const items = enabled ? (results.data?.items ?? []) : [];
  const searching = enabled && (results.isPending || text.trim() !== search);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId}>Customer</Label>
      <Input
        id={inputId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Search by name, email or company"
        autoComplete="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={`${inputId}-status`}
      />
      <div id={`${inputId}-status`} aria-live="polite" className="text-sm">
        {error ? <p className="text-destructive">{error}</p> : null}
        {searching ? <p className="text-muted-foreground">Searching...</p> : null}
        {enabled && results.isError ? (
          <p className="text-destructive">Unable to search customers.</p>
        ) : null}
        {enabled && !searching && !results.isError && items.length === 0 ? (
          <p className="text-muted-foreground">No customers found.</p>
        ) : null}
      </div>
      {items.length > 0 ? (
        <ul className="border-border divide-border divide-y overflow-hidden rounded-lg border">
          {items.map((customer) => {
            const name = [customer.firstName, customer.lastName].filter(Boolean).join(" ");
            const subtitle = [customer.email, customer.company].filter(Boolean).join(" · ") || null;
            return (
              <li key={customer.id}>
                <button
                  type="button"
                  onClick={() => onChange({ id: customer.id, name, subtitle })}
                  className="hover:bg-muted focus-visible:bg-muted flex w-full flex-col px-3 py-2 text-left outline-none"
                >
                  <span className="text-sm font-medium">{name}</span>
                  {subtitle ? (
                    <span className="text-muted-foreground text-xs">{subtitle}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
