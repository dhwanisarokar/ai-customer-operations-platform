import { notFound, redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerForm } from "@/features/customers/components/customer-form";
import { parseUuidParam } from "@/server/http/params";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { requireCustomer } from "@/server/services/customers";

export const dynamic = "force-dynamic";

export default async function EditCustomerPage({
  params,
}: {
  params: Promise<{ customerId: string }>;
}) {
  const ctx = await requirePageContext();
  const { customerId } = await params;
  if (!ctx.can("update_customers")) redirect(`/dashboard/customers/${customerId}`);

  const customer = await loadCustomer(ctx, customerId);

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">Edit customer</h1>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerForm
            mode="edit"
            customerId={customer.id}
            initialValues={{
              firstName: customer.firstName,
              lastName: customer.lastName ?? "",
              email: customer.email ?? "",
              phone: customer.phone ?? "",
              company: customer.company ?? "",
              jobTitle: customer.jobTitle ?? "",
              source: customer.source ?? "",
              status: customer.status === "INACTIVE" ? "INACTIVE" : "ACTIVE",
            }}
          />
        </CardContent>
      </Card>
    </main>
  );
}

async function loadCustomer(ctx: Awaited<ReturnType<typeof requirePageContext>>, id: string) {
  try {
    return await requireCustomer(ctx, parseUuidParam(id, "Customer"));
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
}
