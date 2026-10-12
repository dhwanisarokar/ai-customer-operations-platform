import { PortalSettingsCard } from "@/features/portal/components/portal-admin";
import { WidgetSettingsForm } from "@/features/widget/components/widget-settings-form";
import { requirePageContext } from "@/server/auth/page-context";

export const dynamic = "force-dynamic";

export default async function WidgetSettingsPage() {
  const ctx = await requirePageContext();
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Web chat</h1>
        <p className="text-muted-foreground text-sm">
          Let visitors on your website message your team. Conversations appear in the inbox, and
          replies are written by your team (the AI only drafts suggestions for you to review).
        </p>
      </div>
      {ctx.can("manage_widget") ? (
        <WidgetSettingsForm />
      ) : (
        <p className="text-muted-foreground text-sm">
          Only owners and admins can manage the web chat widget.
        </p>
      )}
      {ctx.can("manage_portal") ? <PortalSettingsCard /> : null}
    </main>
  );
}
