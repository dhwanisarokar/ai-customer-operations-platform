import type { PortalConversationDto } from "@/server/portal/conversations";
import type { HelpArticle, HelpArticleSummary } from "@/server/portal/help";
import type { PortalProfile } from "@/server/portal/profile";
import type { VisitorMessageDto } from "@/server/widget/visitor";

export type { HelpArticle, HelpArticleSummary, PortalConversationDto, PortalProfile };
export type PortalMessage = VisitorMessageDto;

export type Paged<T> = { items: T[]; total: number; page: number; pageSize: number };
export type PortalSummary = {
  organization: { name: string; slug: string };
  total: number;
  open: number;
  recent: PortalConversationDto[];
};
export type PortalConversationResponse = {
  conversation: PortalConversationDto;
  messages: PortalMessage[];
};
export type PortalMe = {
  organization: { name: string; slug: string };
  linked: boolean;
  customer?: { firstName: string; lastName: string | null };
};
export type SendInput = { body: string; clientMessageId: string };

/** Query keys, namespaced by the portal (organization slug): switching portals never mixes caches. */
export const portalKeys = {
  all: (slug: string) => ["portal", slug] as const,
  me: (slug: string) => ["portal", slug, "me"] as const,
  summary: (slug: string) => ["portal", slug, "summary"] as const,
  conversations: (slug: string) => ["portal", slug, "conversations"] as const,
  conversationList: (slug: string, page: number) =>
    ["portal", slug, "conversations", "list", page] as const,
  conversation: (slug: string, id: string) =>
    ["portal", slug, "conversations", "item", id] as const,
  profile: (slug: string) => ["portal", slug, "profile"] as const,
  help: (slug: string, q: string, page: number) =>
    ["portal", slug, "help", "list", q, page] as const,
  article: (slug: string, id: string) => ["portal", slug, "help", "article", id] as const,
};

export const PORTAL_PAGE_SIZE = 10;
/** How long "AI is thinking" may show before the customer is offered a person instead. */
export const ASSISTANT_PATIENCE_MS = 45_000;
