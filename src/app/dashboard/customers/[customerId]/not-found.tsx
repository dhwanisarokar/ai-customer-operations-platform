import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { buttonVariants } from "@/components/ui/button";

export default function CustomerNotFound() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <EmptyState
        title="Customer not found"
        description="It may have been removed, or you may not have access to it."
        action={
          <Link href="/dashboard/customers" className={buttonVariants({ variant: "outline" })}>
            Back to customers
          </Link>
        }
      />
    </main>
  );
}
