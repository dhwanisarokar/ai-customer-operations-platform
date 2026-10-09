"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function InboxError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
      <Alert variant="destructive">
        <AlertTitle>Unable to load conversations</AlertTitle>
        <AlertDescription>
          Something went wrong while loading the inbox. Please try again.
        </AlertDescription>
      </Alert>
      <Button onClick={reset} variant="outline" className="self-start">
        Try again
      </Button>
    </main>
  );
}
