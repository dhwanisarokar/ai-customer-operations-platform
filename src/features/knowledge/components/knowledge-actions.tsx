"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
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
import { apiRequest } from "@/lib/api-client";

type Status = "DRAFT" | "PUBLISHED" | "ARCHIVED";
type Action = "publish" | "unpublish" | "archive" | "delete";

const BUSY_LABEL: Record<Action, string> = {
  publish: "Indexing and publishing...",
  unpublish: "Unpublishing...",
  archive: "Archiving...",
  delete: "Deleting...",
};

/** Lifecycle buttons. Rules are enforced by the API; this only offers sensible actions. */
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
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [, startTransition] = useTransition();

  async function run(action: Action) {
    setBusy(action);
    setError(null);
    const result =
      action === "delete"
        ? await apiRequest(`/api/knowledge/${documentId}`, { method: "DELETE" })
        : await apiRequest(`/api/knowledge/${documentId}/${action}`, { method: "POST" });
    setBusy(null);
    if (!result.ok) {
      setError(result.message);
      setConfirmDelete(false);
      return;
    }
    setConfirmDelete(false);
    startTransition(() => {
      if (action === "delete") router.push("/dashboard/knowledge");
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap justify-end gap-2">
        {status === "DRAFT" ? (
          <Button onClick={() => run("publish")} disabled={busy !== null}>
            {busy === "publish" ? BUSY_LABEL.publish : "Publish"}
          </Button>
        ) : null}
        {status === "PUBLISHED" ? (
          <Button variant="outline" onClick={() => run("unpublish")} disabled={busy !== null}>
            {busy === "unpublish" ? BUSY_LABEL.unpublish : "Unpublish"}
          </Button>
        ) : null}
        {status === "ARCHIVED" ? (
          <Button variant="outline" onClick={() => run("unpublish")} disabled={busy !== null}>
            {busy === "unpublish" ? "Restoring..." : "Restore as draft"}
          </Button>
        ) : null}
        {status !== "ARCHIVED" ? (
          <Button variant="outline" onClick={() => run("archive")} disabled={busy !== null}>
            {busy === "archive" ? BUSY_LABEL.archive : "Archive"}
          </Button>
        ) : null}

        <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
          <DialogTrigger render={<Button variant="destructive" disabled={busy !== null} />}>
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
              <Button variant="destructive" onClick={() => run("delete")} disabled={busy !== null}>
                {busy === "delete" ? BUSY_LABEL.delete : "Delete document"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-right text-sm">
          {error}
        </p>
      ) : null}
    </div>
  );
}
