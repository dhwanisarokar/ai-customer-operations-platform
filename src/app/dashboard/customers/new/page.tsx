import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CustomerForm } from "@/features/customers/components/customer-form";
import { requirePageContext } from "@/server/auth/page-context";

export const dynamic = "force-dynamic";

export default async function NewCustomerPage() {
  const ctx = await requirePageContext();
  if (!ctx.can("create_customers")) redirect("/dashboard/customers");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">New customer</h1>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <CustomerForm mode="create" />
        </CardContent>
      </Card>
    </main>
  );
}
