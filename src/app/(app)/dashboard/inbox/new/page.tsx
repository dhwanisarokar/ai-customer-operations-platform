import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NewConversationForm } from "@/features/conversations/components/new-conversation-form";
import { flattenSearchParams, type RawSearchParams } from "@/features/customers/list-params";
import { fullName } from "@/features/customers/normalize";
import { requirePageContext } from "@/server/auth/page-context";
import { NotFoundError } from "@/server/errors";
import { requireCustomer } from "@/server/services/customers";
import { z } from "zod";

export const dynamic = "force-dynamic";

export default async function NewConversationPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const ctx = await requirePageContext();
  if (!ctx.can("create_conversations")) redirect("/dashboard/inbox");

  // Optional prefill (?customerId=) from the Customer 360 page. Verified against the caller's
  // organization like any other lookup; an unknown or foreign id simply shows the picker.
  const { customerId } = flattenSearchParams(await searchParams);
  let initialCustomer = null;
  if (customerId && z.uuid().safeParse(customerId).success) {
    try {
      const customer = await requireCustomer(ctx, customerId);
      if (customer.status !== "ARCHIVED") {
        initialCustomer = {
          id: customer.id,
          name: fullName(customer),
          subtitle: [customer.email, customer.company].filter(Boolean).join(" · ") || null,
        };
      }
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">New conversation</h1>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <NewConversationForm initialCustomer={initialCustomer} />
        </CardContent>
      </Card>
    </main>
  );
}
