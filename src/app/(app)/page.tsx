import { auth } from "@clerk/nextjs/server";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";

export default async function HomePage() {
  const { userId } = await auth();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">AI Customer Operations Platform</h1>
        <p className="text-muted-foreground">
          Multi-tenant customer operations, powered by AI agents.
        </p>
      </div>
      <div className="flex gap-3">
        {userId ? (
          <Link href="/dashboard" className={buttonVariants()}>
            Go to dashboard
          </Link>
        ) : (
          <>
            <Link href="/sign-in" className={buttonVariants()}>
              Sign in
            </Link>
            <Link href="/sign-up" className={buttonVariants({ variant: "outline" })}>
              Create account
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
