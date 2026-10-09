import { redirect } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { KnowledgeDocumentForm } from "@/features/knowledge/components/knowledge-document-form";
import { requirePageContext } from "@/server/auth/page-context";

export const dynamic = "force-dynamic";

export default async function NewKnowledgeDocumentPage() {
  const ctx = await requirePageContext();
  if (!ctx.can("edit_knowledge")) redirect("/dashboard/knowledge");

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
      <h1 className="text-2xl font-semibold tracking-tight">New document</h1>
      <Card>
        <CardHeader>
          <CardTitle>Draft</CardTitle>
        </CardHeader>
        <CardContent>
          <KnowledgeDocumentForm mode="create" />
        </CardContent>
      </Card>
    </main>
  );
}
