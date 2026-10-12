"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client";
import { useJoinPortal, usePortalMe } from "../hooks";
import { usePortalInfo } from "../portal-context";
import { ErrorPanel, LoadingRows } from "./portal-states";

const REASONS: Record<string, string> = {
  invite_email_mismatch:
    "This invitation was sent to a different email address. Sign in with the address it was sent to, and make sure that address is verified.",
  conflict:
    "This account or this customer profile is already linked. Ask support if you need help.",
};

/**
 * Accepts an invitation. The token comes from the link (query string) and goes to the server together
 * with the signed-in identity; the server decides. Nothing here chooses a customer or organization.
 */
export function JoinView() {
  const { slug, name } = usePortalInfo();
  const token = useSearchParams().get("token") ?? "";
  const me = usePortalMe();
  const join = useJoinPortal();

  if (me.isPending) return <LoadingRows rows={1} />;
  if (me.isError) return <ErrorPanel error={me.error} onRetry={() => void me.refetch()} />;

  if (join.isSuccess || me.data.linked) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <h1 className="text-2xl font-semibold tracking-tight">You are connected</h1>
        <p className="text-muted-foreground text-sm">
          Your account is linked to your {name} profile.
        </p>
        <Link href={`/portal/${slug}`} className={buttonVariants({ className: "self-start" })}>
          Go to the portal
        </Link>
      </div>
    );
  }

  const error = join.error instanceof ApiError ? join.error : null;
  return (
    <div className="flex max-w-xl flex-col gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Join the {name} portal</h1>
      <p className="text-muted-foreground text-sm">
        Accept your invitation to follow your support conversations. You must be signed in with the
        email address the invitation was sent to.
      </p>
      {!token ? (
        <Alert variant="destructive">
          <AlertDescription>
            This invitation link is incomplete. Open the link from your email again.
          </AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>
            {REASONS[error.code ?? ""] ??
              "This invitation is invalid or has expired. Ask support for a new one."}
          </AlertDescription>
        </Alert>
      ) : null}
      <Button
        className="self-start"
        disabled={!token || join.isPending}
        onClick={() => join.mutate(token)}
      >
        {join.isPending ? "Connecting…" : "Accept invitation"}
      </Button>
    </div>
  );
}
