import { createLogger } from "@/lib/logger";
import { aiProviderAvailable } from "@/server/ai/client";
import { ConflictError, NotFoundError } from "@/server/errors";
import {
  portalConversationsRepository,
  type PortalConversationSummary,
} from "@/server/repositories/portal-conversations";
import { visitorConversationsRepository } from "@/server/repositories/visitor-conversations";
import { widgetSettingsRepository } from "@/server/repositories/widget-settings";
import { persistMessage } from "@/server/services/conversation-messages";
import { createConversationCore } from "@/server/services/conversations";
import {
  customerAiEnabledFor,
  initialHandlingMode,
  scheduleCustomerAiReply,
} from "@/server/services/customer-ai";
import { markHumanRequested } from "@/server/widget/handoff";
import { toMessageDto, type VisitorMessageDto } from "@/server/widget/visitor";
import type { PortalContext } from "./context";

const log = createLogger("portal");

/** Abuse bound on top of the rate limits. */
export const MAX_PORTAL_CONVERSATIONS = 200;
const MAX_VISIBLE_MESSAGES = 200;

/** What a customer may see of a conversation. No assignee, no notes, no AI provenance, no ids but its own. */
export type PortalConversationDto = {
  id: string;
  subject: string;
  status: "OPEN" | "PENDING" | "RESOLVED";
  lastMessageAt: string;
  lastMessagePreview: string | null;
  lastMessageFrom: "customer" | "ai" | "team" | null;
  /** The customer asked for a person and nobody has taken over yet. */
  humanRequested: boolean;
  /** Who answers new messages: the AI assistant, a person, or nobody automatic. */
  assistant: "ai" | "human" | "none";
  createdAt: string;
};

function from(sender: PortalConversationSummary["lastMessageSenderType"]) {
  if (sender === "CUSTOMER") return "customer" as const;
  if (sender === "USER") return "team" as const;
  if (sender === "AI_AGENT") return "ai" as const;
  return null;
}

async function aiAvailable(organizationId: string): Promise<boolean> {
  if (!aiProviderAvailable()) return false;
  const settings = await widgetSettingsRepository.findByOrganization(organizationId);
  return customerAiEnabledFor(settings, "PORTAL");
}

function toDto(row: PortalConversationSummary, ai: boolean): PortalConversationDto {
  const assistant: PortalConversationDto["assistant"] = ai
    ? row.handlingMode === "AI"
      ? "ai"
      : "human"
    : row.humanRequestedAt || row.assignedToUserId
      ? "human"
      : "none";
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
    lastMessageFrom: from(row.lastMessageSenderType),
    humanRequested: row.humanRequestedAt !== null,
    assistant,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The conversation only if THIS customer owns it; anything else is "not found" (no enumeration). */
async function requireOwned(ctx: PortalContext, conversationId: string) {
  const conversation = await portalConversationsRepository.findOwned(
    ctx.organization.id,
    ctx.customer.id,
    conversationId,
  );
  if (!conversation) throw new NotFoundError("Conversation not found");
  return conversation;
}

export async function listPortalConversations(
  ctx: PortalContext,
  page: { page: number; pageSize: number },
) {
  const [{ items, total }, ai] = await Promise.all([
    portalConversationsRepository.list(ctx.organization.id, ctx.customer.id, page),
    aiAvailable(ctx.organization.id),
  ]);
  return {
    items: items.map((row) => toDto(row, ai)),
    total,
    page: page.page,
    pageSize: page.pageSize,
  };
}

/** Home summary: counts and the most recently updated conversations. */
export async function getPortalSummary(ctx: PortalContext) {
  const [counts, recent] = await Promise.all([
    portalConversationsRepository.counts(ctx.organization.id, ctx.customer.id),
    listPortalConversations(ctx, { page: 1, pageSize: 5 }),
  ]);
  return { ...counts, recent: recent.items };
}

export async function getPortalConversation(ctx: PortalContext, conversationId: string) {
  const [conversation, ai] = await Promise.all([
    requireOwned(ctx, conversationId),
    aiAvailable(ctx.organization.id),
  ]);
  const messages = await visitorConversationsRepository.messages(
    ctx.organization.id,
    conversation.id,
    MAX_VISIBLE_MESSAGES,
  );
  return {
    conversation: toDto(conversation, ai),
    messages: messages.map(toMessageDto) satisfies VisitorMessageDto[],
  };
}

/**
 * Starts a support conversation from the portal. The customer is the linked customer (from the server-side
 * context), the actor is `portal`, and the first message is a normal CUSTOMER message. Idempotent per
 * `clientMessageId`. The AI answer (if customer AI is on and the conversation starts in AI mode) is queued
 * asynchronously: this call never waits for the model.
 */
export async function createPortalConversation(
  ctx: PortalContext,
  input: { subject: string; body: string; clientMessageId: string },
) {
  const { organization, customer } = ctx;

  const existing = await portalConversationsRepository.findByClientMessage(
    organization.id,
    customer.id,
    input.clientMessageId,
  );
  if (existing) {
    const found = await getPortalConversation(ctx, existing);
    await scheduleAiFor(ctx, found, input.clientMessageId); // a retry also covers a lost enqueue
    return { ...found, duplicate: true };
  }

  const count = await portalConversationsRepository.countForCustomer(organization.id, customer.id);
  if (count >= MAX_PORTAL_CONVERSATIONS) {
    throw new ConflictError("You have reached the maximum number of conversations");
  }

  const conversation = await createConversationCore({
    organizationId: organization.id,
    actor: { kind: "portal", customerId: customer.id },
    clientMessageId: input.clientMessageId,
    handlingMode: await initialHandlingMode(organization.id, "PORTAL"),
    input: {
      customerId: customer.id,
      subject: input.subject,
      priority: "NORMAL",
      channel: "PORTAL",
      initialMessage: { body: input.body, from: "CUSTOMER" },
    },
  });
  log.info(
    { organizationId: organization.id, conversationId: conversation.id },
    "portal conversation created",
  );
  const created = await getPortalConversation(ctx, conversation.id);
  await scheduleAiFor(ctx, created, input.clientMessageId);
  return { ...created, duplicate: false };
}

async function scheduleAiFor(
  ctx: PortalContext,
  conversation: { conversation: { id: string }; messages: VisitorMessageDto[] },
  clientMessageId: string,
) {
  const message = conversation.messages.find((m) => m.clientMessageId === clientMessageId);
  if (!message) return;
  await scheduleCustomerAiReply({
    organizationId: ctx.organization.id,
    conversationId: conversation.conversation.id,
    messageId: message.id,
  });
}

/** A customer message: always authored by the linked customer, through the shared message path. */
export async function sendPortalMessage(
  ctx: PortalContext,
  conversationId: string,
  input: { body: string; clientMessageId: string },
) {
  const conversation = await requireOwned(ctx, conversationId);
  const { message, duplicate } = await persistMessage({
    organizationId: ctx.organization.id,
    actor: { kind: "portal", customerId: ctx.customer.id },
    conversationId: conversation.id,
    input: { body: input.body, type: "MESSAGE", from: "CUSTOMER" },
    clientMessageId: input.clientMessageId,
  });
  // Queue (or re-queue, for a retry) the assistant's answer; the handling mode decides, never the client.
  await scheduleCustomerAiReply({
    organizationId: ctx.organization.id,
    conversationId: conversation.id,
    messageId: message.id,
  });
  return {
    duplicate,
    message: toMessageDto({
      id: message.id,
      senderType: "CUSTOMER",
      body: message.body,
      createdAt: message.createdAt,
      clientMessageId: input.clientMessageId,
      metadata: null,
      sender: null,
    }),
  };
}

/** "Talk to a person" from the portal: the same handoff as the web chat (marker, HUMAN mode, events). */
export async function requestPortalHuman(ctx: PortalContext, conversationId: string) {
  const conversation = await requireOwned(ctx, conversationId);
  const requested = await markHumanRequested({
    organizationId: ctx.organization.id,
    conversationId: conversation.id,
    requester: { customerId: ctx.customer.id },
  });
  return { humanRequested: true, alreadyRequested: !requested };
}
