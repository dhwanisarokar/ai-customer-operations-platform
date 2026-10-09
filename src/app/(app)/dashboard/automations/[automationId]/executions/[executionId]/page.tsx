import Link from "next/link";
import { notFound } from "next/navigation";
import { ExecutionDetailView } from "@/features/automations/components/execution-detail-view";
import { serialize } from "@/lib/query/serialize";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { parseUuidParam } from "@/server/http/params";
import { getAutomation, getExecution } from "@/server/services/automations";

export const dynamic = "force-dynamic";

export default async function ExecutionPage({
  params,
}: {
  params: Promise<{ automationId: string; executionId: string }>;
}) {
  const ctx = await requirePageContext();
  const resolved = await params;

  let loaded;
  try {
    const automationId = parseUuidParam(resolved.automationId, "Automation");
    const executionId = parseUuidParam(resolved.executionId, "Execution");
    loaded = await Promise.all([
      getAutomation(ctx, automationId),
      getExecution(ctx, automationId, executionId),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const [automation, execution] = loaded;

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <Link
        href={`/dashboard/automations/${automation.id}`}
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; {automation.name}
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">Run details</h1>
      <ExecutionDetailView
        automationId={automation.id}
        executionId={execution.id}
        initialData={serialize({ execution })}
      />
    </main>
  );
}
