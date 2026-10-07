import { Skeleton } from "@/components/ui/skeleton";

export default function InboxLoading() {
  return (
    <main
      className="mx-auto flex w-full max-w-[96rem] flex-col gap-4 px-4 py-6"
      aria-busy="true"
      aria-label="Loading inbox"
    >
      <Skeleton className="h-9 w-40" />
      <div className="grid gap-4 lg:grid-cols-[13rem_minmax(20rem,26rem)_1fr]">
        <Skeleton className="hidden h-64 lg:block" />
        <div className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="hidden h-[32rem] lg:block" />
      </div>
    </main>
  );
}
