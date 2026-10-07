import { SignOutButton } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { QueryProvider } from "@/lib/query/query-provider";
import { getActiveOrganizationId } from "@/server/auth/page-context";
import { DashboardNav } from "@/components/shared/dashboard-nav";
import { MobileNav } from "@/components/shared/mobile-nav";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const organizationId = await getActiveOrganizationId();
  return (
    <QueryProvider organizationId={organizationId}>
      <div className="flex h-dvh flex-col">
        <header className="border-border bg-card relative shrink-0 border-b">
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-6">
            <div className="flex min-w-0 items-center gap-6">
              <span className="truncate text-sm font-semibold tracking-tight">AI Customer Ops</span>
              <div className="hidden md:block">
                <DashboardNav />
              </div>
            </div>
            <div className="hidden md:block">
              <SignOutButton redirectUrl="/">
                <Button variant="outline" size="sm">
                  Sign out
                </Button>
              </SignOutButton>
            </div>
            <MobileNav />
          </div>
        </header>
        {/* The header stays put; each page scrolls inside this region (the inbox manages its own panes). */}
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </QueryProvider>
  );
}
