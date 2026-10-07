import { SignOutButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { QueryProvider } from "@/lib/query/query-provider";
import { getActiveOrganizationId } from "@/server/auth/page-context";
import { DashboardNav } from "@/components/shared/dashboard-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const organizationId = await getActiveOrganizationId();
  return (
    <QueryProvider organizationId={organizationId}>
      <div className="flex min-h-screen flex-col">
        <header className="border-border bg-card border-b">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-6">
            <div className="flex items-center gap-6">
              <span className="text-sm font-semibold tracking-tight">AI Customer Ops</span>
              <DashboardNav />
            </div>
            <SignOutButton redirectUrl="/">
              <Button variant="outline" size="sm">
                Sign out
              </Button>
            </SignOutButton>
          </div>
        </header>
        <div className="flex-1">{children}</div>
      </div>
    </QueryProvider>
  );
}
