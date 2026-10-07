import Link from "next/link";
import { NativeSelect } from "@/components/shared/native-select";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Props = {
  params: Record<string, string>;
  tags: { id: string; name: string }[];
};

/**
 * A plain GET form: filters live in the URL (shareable, back-button friendly) and the page
 * re-renders on the server. Changing filters resets to page 1 by simply omitting `page`.
 */
export function CustomerFilters({ params, tags }: Props) {
  const hasFilters = [
    "q",
    "status",
    "tagIds",
    "company",
    "source",
    "createdFrom",
    "createdTo",
  ].some((key) => params[key]);

  return (
    <form method="get" action="/dashboard/customers" className="flex flex-col gap-3" role="search">
      {/* Preserve sorting while filtering. */}
      {params.sort ? <input type="hidden" name="sort" value={params.sort} /> : null}
      {params.order ? <input type="hidden" name="order" value={params.order} /> : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Search" htmlFor="filter-q">
          <Input
            id="filter-q"
            name="q"
            type="search"
            placeholder="Name, email, company, phone"
            defaultValue={params.q ?? ""}
            maxLength={100}
          />
        </Field>
        <Field label="Status" htmlFor="filter-status">
          <NativeSelect id="filter-status" name="status" defaultValue={params.status ?? ""}>
            <option value="">Active &amp; inactive</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
            <option value="ARCHIVED">Archived</option>
            <option value="ALL">All (including archived)</option>
          </NativeSelect>
        </Field>
        <Field label="Tag" htmlFor="filter-tag">
          <NativeSelect id="filter-tag" name="tagIds" defaultValue={params.tagIds ?? ""}>
            <option value="">Any tag</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Company" htmlFor="filter-company">
          <Input
            id="filter-company"
            name="company"
            defaultValue={params.company ?? ""}
            maxLength={150}
          />
        </Field>
        <Field label="Source" htmlFor="filter-source">
          <Input
            id="filter-source"
            name="source"
            defaultValue={params.source ?? ""}
            maxLength={50}
          />
        </Field>
        <Field label="Created from" htmlFor="filter-from">
          <Input
            id="filter-from"
            name="createdFrom"
            type="date"
            defaultValue={params.createdFrom?.slice(0, 10) ?? ""}
          />
        </Field>
        <Field label="Created to" htmlFor="filter-to">
          <Input
            id="filter-to"
            name="createdTo"
            type="date"
            defaultValue={params.createdTo?.slice(0, 10) ?? ""}
          />
        </Field>
      </div>

      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Apply filters
        </Button>
        {hasFilters ? (
          <Link
            href="/dashboard/customers"
            className={buttonVariants({ variant: "ghost", size: "sm" })}
          >
            Clear
          </Link>
        ) : null}
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
