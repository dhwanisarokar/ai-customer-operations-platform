import Link from "next/link";
import { NativeSelect } from "@/components/shared/native-select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { flattenSearchParams, type RawSearchParams } from "@/features/customers/list-params";
import { KnowledgeListView } from "@/features/knowledge/components/knowledge-list-view";
import { parseKnowledgeListParams } from "@/features/knowledge/list-params";
import { serialize } from "@/lib/query/serialize";
import { requirePageContext } from "@/server/auth/page-context";
import { listDocuments } from "@/server/services/knowledge";

export const dynamic = "force-dynamic";

export default async function KnowledgePage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const ctx = await requirePageContext();
  const params = flattenSearchParams(await searchParams);
  const { query, invalid } = parseKnowledgeListParams(params);
  const result = await listDocuments(ctx, query);
  const filtered = Boolean(query.q || query.status);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Knowledge base</h1>
          <p className="text-muted-foreground text-sm">
            Published documents are what the AI agent uses to answer customers.
          </p>
        </div>
        {ctx.can("edit_knowledge") ? (
          <Link href="/dashboard/knowledge/new" className={buttonVariants()}>
            New document
          </Link>
        ) : null}
      </div>

      {invalid ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Some filters were invalid and have been reset.</AlertDescription>
        </Alert>
      ) : null}

      <form
        method="get"
        action="/dashboard/knowledge"
        role="search"
        className="flex flex-wrap items-end gap-3"
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor="kb-q" className="text-sm font-medium">
            Search
          </label>
          <Input
            id="kb-q"
            name="q"
            type="search"
            defaultValue={params.q ?? ""}
            maxLength={100}
            className="w-64"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="kb-status" className="text-sm font-medium">
            Status
          </label>
          <NativeSelect
            id="kb-status"
            name="status"
            defaultValue={params.status ?? ""}
            className="w-40"
          >
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
            <option value="ARCHIVED">Archived</option>
          </NativeSelect>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
        {filtered ? (
          <Link href="/dashboard/knowledge" className={buttonVariants({ variant: "ghost" })}>
            Clear
          </Link>
        ) : null}
      </form>

      <KnowledgeListView
        query={query}
        params={params}
        initialData={serialize(result)}
        filtered={filtered}
        canCreate={ctx.can("edit_knowledge")}
      />
    </main>
  );
}
