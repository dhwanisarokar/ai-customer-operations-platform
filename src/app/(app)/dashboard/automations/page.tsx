import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { AUTOMATIONS_PAGE } from "@/features/automations/api/types";
import { AutomationListView } from "@/features/automations/components/automation-list-view";
import { serialize } from "@/lib/query/serialize";
import { requirePageContext } from "@/server/auth/page-context";
import { listAutomations } from "@/server/services/automations";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const ctx = await requirePageContext();
  const result = await listAutomations(ctx, AUTOMATIONS_PAGE);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Automations</h1>
          <p className="text-muted-foreground text-sm">
            When something happens, run actions automatically. Rules are deterministic: no AI
            decides what runs.
          </p>
        </div>
        {ctx.can("create_automations") ? (
          <Link href="/dashboard/automations/new" className={buttonVariants()}>
            New automation
          </Link>
        ) : null}
      </div>
      <AutomationListView
        initialData={serialize(result)}
        canCreate={ctx.can("create_automations")}
        canUpdate={ctx.can("update_automations")}
      />
    </main>
  );
}
