import Link from "next/link";
import { EmptyState } from "@/components/shared/empty-state";
import { buttonVariants } from "@/components/ui/button";

export default function KnowledgeDocumentNotFound() {
  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-12">
      <EmptyState
        title="Document not found"
        description="It may have been deleted, or you may not have access to it."
        action={
          <Link href="/dashboard/knowledge" className={buttonVariants({ variant: "outline" })}>
            Back to the knowledge base
          </Link>
        }
      />
    </main>
  );
}
