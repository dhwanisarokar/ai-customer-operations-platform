import type { Metadata } from "next";
import { WidgetApp } from "@/features/widget/components/widget-app";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Chat", robots: { index: false, follow: false } };

/**
 * The embeddable chat, shown inside the iframe that public/widget.js creates. It is public: the key
 * in the URL only selects a widget; everything else is decided by the server from the visitor session.
 */
export default async function WidgetPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ embed?: string }>;
}) {
  const { key } = await params;
  const { embed } = await searchParams;
  return <WidgetApp widgetKey={key} embedOrigin={typeof embed === "string" ? embed : undefined} />;
}
