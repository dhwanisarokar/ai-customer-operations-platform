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

export function ArchiveCustomerButton({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  async function archive() {
    setBusy(true);
    setError(null);
    const result = await apiRequest(`/api/customers/${customerId}`, { method: "DELETE" });
    setBusy(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setOpen(false);
    startTransition(() => {
      router.push("/dashboard/customers");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" />}>Archive</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Archive {customerName}?</DialogTitle>
          <DialogDescription>
            The customer is hidden from the default list but keeps their notes, tags and history.
            You can restore them later by setting the status back to active.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={archive} disabled={busy}>
            {busy ? "Archiving..." : "Archive customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
