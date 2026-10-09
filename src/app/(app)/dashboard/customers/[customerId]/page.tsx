import Link from "next/link";
import { notFound } from "next/navigation";
import { CustomerDetailView } from "@/features/customers/components/customer-detail-view";
import { serialize } from "@/lib/query/serialize";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { parseUuidParam } from "@/server/http/params";
import { listTags } from "@/server/services/customer-tags";
import { getCustomer360 } from "@/server/services/customers";

export const dynamic = "force-dynamic";

/** Server component: authorizes and fetches the first render; the client view owns the data after that. */
export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const ctx = await requirePageContext();
  const { customerId } = await params;

  let data: Awaited<ReturnType<typeof getCustomer360>>;
  try {
    data = await getCustomer360(ctx, parseUuidParam(customerId, "Customer"));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const organizationTags = ctx.can("tag_customers") ? await listTags(ctx) : [];

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-8">
      <Link
        href="/dashboard/customers"
        className="text-muted-foreground hover:text-foreground w-fit text-sm"
      >
        &larr; All customers
      </Link>
      <CustomerDetailView
        customerId={data.customer.id}
        initial={serialize(data)}
        initialOrganizationTags={serialize({ tags: organizationTags })}
        can={{
          update: ctx.can("update_customers"),
          archive: ctx.can("archive_customers"),
          tag: ctx.can("tag_customers"),
          addNotes: ctx.can("add_customer_notes"),
          viewConversations: ctx.can("view_conversations"),
          createConversations: ctx.can("create_conversations"),
        }}
      />
    </main>
  );
}
