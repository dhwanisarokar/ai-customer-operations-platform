import { Skeleton } from "@/components/ui/skeleton";

export default function KnowledgeLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8"
      aria-busy="true"
      aria-label="Loading knowledge base"
    >
      <Skeleton className="h-9 w-56" />
      <Skeleton className="h-12 w-full" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-12 w-full" />
        ))}
      </div>
    </main>
  );
}
