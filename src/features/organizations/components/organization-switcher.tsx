"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Option = { id: string; name: string };

/**
 * Switching only stores a *preference*; the server re-verifies membership on every request, so
 * tampering with the id sent from here cannot widen access.
 */
export function OrganizationSwitcher({
  organizations,
  activeId,
}: {
  organizations: Option[];
  activeId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const items = organizations.map((o) => ({ value: o.id, label: o.name }));

  async function switchTo(organizationId: string | null) {
    if (!organizationId || organizationId === activeId) return;
    setError(null);
    const response = await fetch("/api/me/active-organization", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organizationId }),
    });
    if (!response.ok) {
      setError("Could not switch organization. Please try again.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col gap-1">
      <Select items={items} value={activeId} onValueChange={switchTo} disabled={pending}>
        <SelectTrigger aria-label="Switch organization" className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
