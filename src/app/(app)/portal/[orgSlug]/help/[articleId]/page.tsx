import { notFound } from "next/navigation";
import { z } from "zod";
import { HelpArticleView } from "@/features/portal/components/help-center";

export default async function PortalArticlePage({
  params,
}: {
  params: Promise<{ articleId: string }>;
}) {
  const { articleId } = await params;
  if (!z.uuid().safeParse(articleId).success) notFound();
  return <HelpArticleView articleId={articleId} />;
}
