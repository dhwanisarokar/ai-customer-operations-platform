import Link from "next/link";
import { notFound } from "next/navigation";
import { KnowledgeDocumentView } from "@/features/knowledge/components/knowledge-document-view";
import { serialize } from "@/lib/query/serialize";
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

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <Link
        href="/dashboard/knowledge"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; Knowledge base
      </Link>
      <KnowledgeDocumentView
        documentId={document.id}
        initial={serialize({ document })}
        can={{ editDraft: ctx.can("edit_knowledge"), manage: ctx.can("publish_knowledge") }}
      />
    </main>
  );
}
