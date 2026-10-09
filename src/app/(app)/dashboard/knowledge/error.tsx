"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function KnowledgeError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-8">
      <Alert variant="destructive">
        <AlertTitle>Unable to load the knowledge base</AlertTitle>
        <AlertDescription>Something went wrong. Please try again.</AlertDescription>
      </Alert>
      <Button onClick={reset} variant="outline" className="self-start">
        Try again
      </Button>
    </main>
  );
}
