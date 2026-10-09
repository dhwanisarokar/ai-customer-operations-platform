import { Skeleton } from "@/components/ui/skeleton";

export default function DashboardLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-10"
      aria-busy="true"
      aria-label="Loading dashboard"
    >
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-40 w-full" />
    </main>
  );
}
