import Link from "next/link";
import { notFound } from "next/navigation";
import { AUTOMATIONS_PAGE } from "@/features/automations/api/types";
import { AutomationForm } from "@/features/automations/components/automation-form";
import { ExecutionHistory } from "@/features/automations/components/execution-history";
import { serialize } from "@/lib/query/serialize";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { parseUuidParam } from "@/server/http/params";
import { getAutomation, listExecutions } from "@/server/services/automations";
import { listMembers } from "@/server/services/memberships";

export const dynamic = "force-dynamic";

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ automationId: string }>;
}) {
  const ctx = await requirePageContext();
  const { automationId } = await params;

  let loaded;
  try {
    const id = parseUuidParam(automationId, "Automation");
    loaded = await Promise.all([
      getAutomation(ctx, id),
      listExecutions(ctx, id, AUTOMATIONS_PAGE),
      listMembers(ctx),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [automation, executions, members] = loaded;

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-8">
      <Link
        href="/dashboard/automations"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; Automations
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight break-words">{automation.name}</h1>
      <AutomationForm
        mode="edit"
        automation={serialize(automation)}
        canEdit={ctx.can("update_automations")}
        canDelete={ctx.can("delete_automations")}
        members={members.map((member) => ({
          id: member.userId,
          label: member.name ?? member.email,
        }))}
      />
      <section aria-label="Execution history" className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Execution history</h2>
        <ExecutionHistory automationId={automation.id} initialData={serialize(executions)} />
      </section>
    </main>
  );
}
