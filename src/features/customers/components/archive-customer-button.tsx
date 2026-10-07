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
import { useArchiveCustomer } from "../hooks/mutations";

/** Archives with optimistic UI: the customer disappears from lists at once; a failure restores it. */
export function ArchiveCustomerButton({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const archive = useArchiveCustomer();

  async function onArchive() {
    try {
      await archive.mutateAsync({ customerId });
      setOpen(false);
      router.push("/dashboard/customers");
    } catch {
      // The cache was rolled back; the error is shown below and the dialog stays open.
    }
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
        {archive.error ? (
          <p role="alert" className="text-destructive text-sm">
            {archive.error.message}
          </p>
        ) : null}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button variant="destructive" onClick={onArchive} disabled={archive.isPending}>
            {archive.isPending ? "Archiving..." : "Archive customer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
