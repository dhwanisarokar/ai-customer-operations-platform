import { Skeleton } from "@/components/ui/skeleton";

export default function CustomersLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8"
      aria-busy="true"
      aria-label="Loading customers"
    >
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-28 w-full" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-11 w-full" />
        ))}
      </div>
    </main>
  );
}
