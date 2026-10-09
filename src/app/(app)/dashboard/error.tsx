"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function DashboardError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-10">
      <Alert variant="destructive">
        <AlertTitle>Something went wrong</AlertTitle>
        <AlertDescription>We could not load your dashboard. Please try again.</AlertDescription>
      </Alert>
      <Button onClick={reset} variant="outline" className="self-start">
        Try again
      </Button>
    </main>
  );
}
