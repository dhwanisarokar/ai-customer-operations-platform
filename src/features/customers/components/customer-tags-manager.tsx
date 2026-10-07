"use client";

import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/api-client";

type Tag = { id: string; name: string };

/**
 * Shows a customer's tags and lets the user add (existing or brand-new, by name) and remove
 * them. All rules (tenant scoping, duplicates) are enforced by the API; this only renders.
 */
export function CustomerTagsManager({
  customerId,
  tags,
  organizationTags,
  canTag,
}: {
  customerId: string;
  tags: Tag[];
  organizationTags: Tag[];
  canTag: boolean;
}) {
  const router = useRouter();
  const listId = useId();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const assignedIds = new Set(tags.map((tag) => tag.id));
  const suggestions = organizationTags.filter((tag) => !assignedIds.has(tag.id));

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function addTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/customers/${customerId}/tags`, {
      method: "POST",
      body: { name: value },
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.fieldErrors.name ?? result.message);
      return;
    }
    setName("");
    refresh();
  }

  async function removeTag(tag: Tag) {
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/customers/${customerId}/tags/${tag.id}`, {
      method: "DELETE",
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    refresh();
  }

  return (
    <div className="flex flex-col gap-3">
      {tags.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Customer tags">
          {tags.map((tag) => (
            <li key={tag.id}>
              <Badge variant="secondary" className="gap-1">
                {tag.name}
                {canTag ? (
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    disabled={busy}
                    aria-label={`Remove tag ${tag.name}`}
                    className="hover:text-destructive -mr-1 rounded-sm outline-none focus-visible:ring-2"
                  >
                    <XIcon className="size-3" aria-hidden="true" />
                  </button>
                ) : null}
              </Badge>
            </li>
          ))}
        </ul>
      )}

      {canTag ? (
        <form onSubmit={addTag} className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            list={listId}
            placeholder="Add a tag"
            aria-label="Add a tag"
            maxLength={40}
            disabled={busy}
          />
          <datalist id={listId}>
            {suggestions.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
          <Button type="submit" variant="outline" disabled={busy || !name.trim()}>
            Add
          </Button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
