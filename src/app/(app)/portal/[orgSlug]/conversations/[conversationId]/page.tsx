import { notFound } from "next/navigation";
import { z } from "zod";
import { ConversationDetail } from "@/features/portal/components/conversation-detail";

/** A malformed id is a 404 right away; a well-formed id still has to be OWNED (checked by the API). */
export default async function PortalConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  if (!z.uuid().safeParse(conversationId).success) notFound();
  return <ConversationDetail conversationId={conversationId} />;
}
