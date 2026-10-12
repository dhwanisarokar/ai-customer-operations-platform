import { notFound } from "next/navigation";
import { PortalInfoProvider } from "@/features/portal/portal-context";
import { PortalShell } from "@/features/portal/components/portal-shell";
import { QueryProvider } from "@/lib/query/query-provider";
import { requirePortalOrganization } from "@/server/portal/context";
import { NotFoundError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * The customer portal frame (separate from the staff dashboard). The organization comes from the URL slug
 * and is only a selector: an unknown or disabled portal is a 404 for everybody. Authentication is enforced
 * by the middleware for the pages and by every API route; the customer link is verified server-side on
 * every API call.
 */
export default async function PortalLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  let organization;
  try {
    organization = await requirePortalOrganization(orgSlug);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <QueryProvider organizationId={organization.id}>
      <PortalInfoProvider info={{ slug: organization.slug, name: organization.name }}>
        <PortalShell>{children}</PortalShell>
      </PortalInfoProvider>
    </QueryProvider>
  );
}
