import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KnowledgeActions } from "@/features/knowledge/components/knowledge-actions";
import { KnowledgeDocumentForm } from "@/features/knowledge/components/knowledge-document-form";
import { KnowledgeStatusBadge } from "@/features/knowledge/components/knowledge-status-badge";
import { formatDateTime } from "@/lib/format";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { parseUuidParam } from "@/server/http/params";
import { getDocument } from "@/server/services/knowledge";

export const dynamic = "force-dynamic";

export default async function KnowledgeDocumentPage({
  params,
}: {
  params: Promise<{ documentId: string }>;
}) {
  const ctx = await requirePageContext();
  const { documentId } = await params;

  let document: Awaited<ReturnType<typeof getDocument>>;
  try {
    document = await getDocument(ctx, parseUuidParam(documentId, "Document"));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }

  // Drafts can be edited by members; anything that is or was live needs publish rights.
  const canEdit =
    document.status === "DRAFT" ? ctx.can("edit_knowledge") : ctx.can("publish_knowledge");
  const canManage = ctx.can("publish_knowledge");

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <Link
        href="/dashboard/knowledge"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; Knowledge base
      </Link>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{document.title}</h1>
            <KnowledgeStatusBadge status={document.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            Updated {formatDateTime(document.updatedAt)} by{" "}
            {document.updatedBy?.name ?? document.updatedBy?.email ?? "a former member"}
            {document.status === "PUBLISHED"
              ? ` · ${document.chunkCount} indexed passage${document.chunkCount === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>
        {canManage ? (
          <KnowledgeActions
            documentId={document.id}
            title={document.title}
            status={document.status}
          />
        ) : null}
      </header>

      {document.status === "DRAFT" && canManage ? (
        <p className="text-muted-foreground text-sm">
          This is a draft. The AI cannot use it until you publish it.
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{canEdit ? "Edit" : "Content"}</CardTitle>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <KnowledgeDocumentForm
              mode="edit"
              documentId={document.id}
              live={document.status === "PUBLISHED"}
              initialValues={{
                title: document.title,
                description: document.description ?? "",
                content: document.content,
              }}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {document.description ? (
                <p className="text-muted-foreground text-sm">{document.description}</p>
              ) : null}
              <p className="text-sm break-words whitespace-pre-wrap">{document.content}</p>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
