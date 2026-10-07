"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useArchiveKnowledgeDocument,
  useDeleteKnowledgeDocument,
  usePublishKnowledgeDocument,
  useUnpublishKnowledgeDocument,
} from "../hooks/mutations";

type Status = "DRAFT" | "PUBLISHED" | "ARCHIVED";

/**
 * Lifecycle buttons. None is optimistic: publishing runs the embedding model, so the button shows a
 * pending state ("Indexing and publishing...") and the document's status changes only when the
 * server confirms. Rules are enforced by the API; this only offers sensible actions.
 */
export function KnowledgeActions({
  documentId,
  title,
  status,
}: {
  documentId: string;
  title: string;
  status: Status;
}) {
  const router = useRouter();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const publish = usePublishKnowledgeDocument(documentId);
  const unpublish = useUnpublishKnowledgeDocument(documentId);
  const archive = useArchiveKnowledgeDocument(documentId);
  const remove = useDeleteKnowledgeDocument(documentId);

  const busy = publish.isPending || unpublish.isPending || archive.isPending || remove.isPending;
  const error = publish.error ?? unpublish.error ?? archive.error ?? remove.error;

  function clearErrors() {
    publish.reset();
    unpublish.reset();
    archive.reset();
    remove.reset();
  }

  async function onDelete() {
    clearErrors();
    try {
      await remove.mutateAsync();
      setConfirmDelete(false);
      router.push("/dashboard/knowledge");
    } catch {
      setConfirmDelete(false); // the error is shown below
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {status === "DRAFT" ? (
          <Button
            onClick={() => {
              clearErrors();
              publish.mutate();
            }}
            disabled={busy}
          >
            {publish.isPending ? "Indexing and publishing..." : "Publish"}
          </Button>
        ) : null}
        {status === "PUBLISHED" ? (
          <Button
            variant="outline"
            onClick={() => {
              clearErrors();
              unpublish.mutate();
            }}
            disabled={busy}
          >
            {unpublish.isPending ? "Unpublishing..." : "Unpublish"}
          </Button>
        ) : null}
        {status === "ARCHIVED" ? (
          <Button
            variant="outline"
            onClick={() => {
              clearErrors();
              unpublish.mutate();
            }}
            disabled={busy}
          >
            {unpublish.isPending ? "Restoring..." : "Restore as draft"}
          </Button>
        ) : null}
        {status !== "ARCHIVED" ? (
          <Button
            variant="outline"
            onClick={() => {
              clearErrors();
              archive.mutate();
            }}
            disabled={busy}
          >
            {archive.isPending ? "Archiving..." : "Archive"}
          </Button>
        ) : null}

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogTrigger render={<Button variant="destructive" disabled={busy} />}>
            Delete
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {title}?</DialogTitle>
              <DialogDescription>
                This permanently deletes the document and its search index. The AI will no longer
                use it. Archive it instead if you may want it back.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
              <Button variant="destructive" onClick={onDelete} disabled={busy}>
                {remove.isPending ? "Deleting..." : "Delete document"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-right text-sm">
          {error.message}
        </p>
      ) : null}
    </div>
  );
}
