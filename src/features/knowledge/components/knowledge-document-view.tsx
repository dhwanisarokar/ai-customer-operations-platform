"use client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime } from "@/lib/format";
import type { KnowledgeDocumentResponse } from "../api/types";
import { useKnowledgeDocument } from "../hooks/queries";
import { KnowledgeActions } from "./knowledge-actions";
import { KnowledgeDocumentForm } from "./knowledge-document-form";
import { KnowledgeStatusBadge } from "./knowledge-status-badge";

type Props = {
  documentId: string;
  initial: KnowledgeDocumentResponse;
  /** UI hints computed by the server; the API enforces every permission regardless. */
  can: { editDraft: boolean; manage: boolean };
};

/**
 * One knowledge document. The status shown is always the server's: publishing calls the embedding
 * model, so nothing here pretends a document is published until the server says so.
 */
export function KnowledgeDocumentView({ documentId, initial, can }: Props) {
  const query = useKnowledgeDocument(documentId, { initialData: initial });
  const document = query.data?.document;

  if (!document) {
    return (
      <div className="flex flex-col gap-3" role="alert">
        <Alert variant="destructive">
          <AlertDescription>
            {query.error?.message ?? "Unable to load this document."}
          </AlertDescription>
        </Alert>
        <Button variant="outline" className="self-start" onClick={() => query.refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  // Drafts can be edited by members; anything that is or was live needs publish rights.
  const canEdit = document.status === "DRAFT" ? can.editDraft : can.manage;

  return (
    <div className="flex flex-col gap-6">
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
        {can.manage ? (
          <KnowledgeActions
            documentId={document.id}
            title={document.title}
            status={document.status}
          />
        ) : null}
      </header>

      {document.status === "DRAFT" && can.manage ? (
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
              // Remount when the server version changes so the form shows the saved values.
              key={document.contentVersion + document.updatedAt}
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
    </div>
  );
}
