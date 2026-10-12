"use client";

import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api-client";
import { usePortalInfo } from "../portal-context";

export function LoadingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-16 w-full" />
      ))}
    </div>
  );
}

/**
 * Error panel with Retry. A "not linked" answer (403 portal_not_linked) is not an error of this view: it
 * explains how to get access instead of offering a pointless retry.
 */
export function ErrorPanel({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  if (error instanceof ApiError && error.code === "portal_not_linked") return <NotLinked />;
  const message =
    error instanceof ApiError && error.status === 404
      ? "We could not find that."
      : "Something went wrong. Please try again.";
  return (
    <Alert variant="destructive">
      <AlertDescription className="flex flex-wrap items-center gap-3">
        <span>{message}</span>
        <Button size="sm" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

/** Signed in, but no customer profile is linked to this account (nothing is shown, nothing is guessed). */
export function NotLinked() {
  const { name } = usePortalInfo();
  return (
    <div className="border-border flex flex-col gap-3 rounded-xl border p-6" role="status">
      <h2 className="text-lg font-semibold">Your account is not linked yet</h2>
      <p className="text-muted-foreground text-sm">
        You are signed in, but this account is not connected to a customer profile at {name}. Access
        is granted by an invitation from {name}&apos;s support team. If you received an invitation
        link, open it while signed in with the email address it was sent to; otherwise ask support
        to invite you.
      </p>
    </div>
  );
}

export function SignedOutHint({ slug }: { slug: string }) {
  return (
    <Link href={`/sign-in?redirect_url=/portal/${slug}`} className={buttonVariants()}>
      Sign in
    </Link>
  );
}
