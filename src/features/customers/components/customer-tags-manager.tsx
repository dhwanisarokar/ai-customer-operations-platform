"use client";

import { XIcon } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { CustomerTagsResponse, OrganizationTagsResponse } from "../api/types";
import { useAddCustomerTag, useRemoveCustomerTag } from "../hooks/mutations";
import { useCustomerTags, useOrganizationTags } from "../hooks/queries";

/**
 * A customer's tags. Adding and removing are optimistic (instant, rolled back with an error if the
 * server refuses); the tag data itself lives in TanStack Query, not in this component.
 */
export function CustomerTagsManager({
  customerId,
  initialTags,
  initialOrganizationTags,
  canTag,
}: {
  customerId: string;
  initialTags: CustomerTagsResponse;
  initialOrganizationTags: OrganizationTagsResponse;
  canTag: boolean;
}) {
  const listId = useId();
  const [name, setName] = useState("");
  const tags = useCustomerTags(customerId, { initialData: initialTags });
  const catalogue = useOrganizationTags({ initialData: initialOrganizationTags });
  const add = useAddCustomerTag(customerId);
  const remove = useRemoveCustomerTag(customerId);

  const assigned = tags.data?.tags ?? [];
  const assignedIds = new Set(assigned.map((tag) => tag.id));
  const suggestions = (catalogue.data?.tags ?? []).filter((tag) => !assignedIds.has(tag.id));
  const error = add.error ?? remove.error;

  function onAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = name.trim();
    if (!value) return;
    const existing = (catalogue.data?.tags ?? []).find(
      (tag) => tag.name.toLowerCase() === value.toLowerCase(),
    );
    remove.reset();
    add.mutate({ name: existing?.name ?? value, tagId: existing?.id });
    setName("");
  }

  return (
    <div className="flex flex-col gap-3">
      {assigned.length === 0 ? (
        <p className="text-muted-foreground text-sm">No tags yet.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5" aria-label="Customer tags">
          {assigned.map((tag) => {
            const pending = tag.id.startsWith("pending:");
            return (
              <li key={tag.id}>
                <Badge variant="secondary" className="gap-1" aria-busy={pending}>
                  {tag.name}
                  {canTag && !pending ? (
                    <button
                      type="button"
                      onClick={() => {
                        add.reset();
                        remove.mutate({ tagId: tag.id });
                      }}
                      aria-label={`Remove tag ${tag.name}`}
                      className="hover:text-destructive -mr-1 rounded-sm outline-none focus-visible:ring-2"
                    >
                      <XIcon className="size-3" aria-hidden="true" />
                    </button>
                  ) : null}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}

      {canTag ? (
        <form onSubmit={onAdd} className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            list={listId}
            placeholder="Add a tag"
            aria-label="Add a tag"
            maxLength={40}
          />
          <datalist id={listId}>
            {suggestions.map((tag) => (
              <option key={tag.id} value={tag.name} />
            ))}
          </datalist>
          <Button type="submit" variant="outline" disabled={!name.trim()}>
            Add
          </Button>
        </form>
      ) : null}

      {error ? (
        <p role="alert" className="text-destructive text-sm">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
