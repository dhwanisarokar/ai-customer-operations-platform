import Link from "next/link";
import { redirect } from "next/navigation";
import { AutomationForm } from "@/features/automations/components/automation-form";
import { requirePageContext } from "@/server/auth/page-context";
import { listMembers } from "@/server/services/memberships";

export const dynamic = "force-dynamic";

export default async function NewAutomationPage() {
  const ctx = await requirePageContext();
  if (!ctx.can("create_automations")) redirect("/dashboard/automations");
  const members = await listMembers(ctx);

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
      <Link
        href="/dashboard/automations"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; Automations
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight">New automation</h1>
      <AutomationForm
        mode="create"
        canEdit
        members={members.map((member) => ({
          id: member.userId,
          label: member.name ?? member.email,
        }))}
      />
    </main>
  );
}
