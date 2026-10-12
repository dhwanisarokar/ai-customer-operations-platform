import { isUniqueViolation } from "@/db/errors";
import { collapseWhitespace } from "@/features/customers/normalize";
import type { WidgetIdentityInput } from "@/features/widget/schemas";
import { createLogger } from "@/lib/logger";
import { ConflictError, NotFoundError } from "@/server/errors";
import { emitDomainEvent } from "@/server/events/bus";
import { customersRepository } from "@/server/repositories/customers";
import {
  visitorConversationsRepository,
  type VisitorConversationSummary,
  type VisitorMessageRow,
} from "@/server/repositories/visitor-conversations";
import { visitorSessionsRepository } from "@/server/repositories/visitor-sessions";
import { createConversationCore } from "@/server/services/conversations";
import { persistMessage } from "@/server/services/conversation-messages";
import { scheduleCustomerAiReply } from "@/server/services/customer-ai";
import { markHumanRequested } from "./handoff";
import type { VisitorContext } from "./session";

const log = createLogger("widget");

/** Most conversations one visitor session may have (abuse bound, on top of rate limits). */
export const MAX_CONVERSATIONS_PER_SESSION = 10;
const MAX_VISIBLE_MESSAGES = 200;
const WEB_CHAT_SOURCE = "web_chat";

// ---- what a visitor may see --------------------------------------------------------------------

export type VisitorMessageDto = {
  id: string;
  /** visitor = you, ai = the virtual assistant, team = a person from the organization. */
  from: "visitor" | "ai" | "team";
  body: string;
  createdAt: string;
  clientMessageId: string | null;
  /** Staff display name (never an email), only on team messages. */
  authorName: string | null;
  /** AI messages only: the assistant suggests talking to a person. */
  handoffSuggested: boolean;
};

export type VisitorConversationDto = {
  id: string;
  subject: string;
  status: "OPEN" | "PENDING" | "RESOLVED";
  lastMessageAt: string;
  lastMessagePreview: string | null;
  humanRequested: boolean;
  /** Who is answering new messages: the assistant, a person, or nobody (AI off, waiting for a team). */
  assistant: "ai" | "human" | "none";
  /** Who wrote the last message (for list previews). */
  lastMessageFrom: "visitor" | "ai" | "team" | null;
  createdAt: string;
};

function lastFrom(sender: VisitorConversationSummary["lastMessageSenderType"]) {
  if (sender === "CUSTOMER") return "visitor" as const;
  if (sender === "USER") return "team" as const;
  if (sender === "AI_AGENT") return "ai" as const;
  return null;
}

function toConversationDto(
  row: VisitorConversationSummary,
  assistant: VisitorConversationDto["assistant"],
): VisitorConversationDto {
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    lastMessageAt: row.lastMessageAt.toISOString(),
    lastMessagePreview: row.lastMessagePreview,
    humanRequested: row.humanRequestedAt !== null,
    assistant,
    lastMessageFrom: lastFrom(row.lastMessageSenderType),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toMessageDto(row: VisitorMessageRow): VisitorMessageDto {
  const fromVisitor = row.senderType === "CUSTOMER";
  const fromAi = row.senderType === "AI_AGENT";
  const meta =
    fromAi && typeof row.metadata === "object" && row.metadata !== null
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    from: fromVisitor ? "visitor" : fromAi ? "ai" : "team",
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    clientMessageId: row.clientMessageId,
    authorName: fromVisitor || fromAi ? null : (row.sender?.name ?? null),
    handoffSuggested: fromAi && meta.handoffSuggested === true,
  };
}

// ---- ownership ---------------------------------------------------------------------------------

/** The conversation only if THIS visitor session owns it; anything else is "not found". */
async function requireOwned(visitor: VisitorContext, conversationId: string) {
  const conversation = await visitorConversationsRepository.findOwned(
    visitor.organizationId,
    visitor.session.id,
    conversationId,
  );
  if (!conversation) throw new NotFoundError("Conversation not found");
  return conversation;
}

/**
 * Who answers this conversation's new messages, from the explicit handling mode: the assistant (AI
 * mode and customer AI enabled), a person (HUMAN mode while customer AI exists for the organization,
 * or a visitor request / assignment), or nobody automatic (customer AI is off).
 */
function assistantFor(
  visitor: VisitorContext,
  row: VisitorConversationSummary,
): VisitorConversationDto["assistant"] {
  if (visitor.widget.aiEnabled) return row.handlingMode === "AI" ? "ai" : "human";
  return row.humanRequestedAt || row.assignedToUserId ? "human" : "none";
}

export async function listVisitorConversations(visitor: VisitorContext) {
  const rows = await visitorConversationsRepository.listForSession(
    visitor.organizationId,
    visitor.session.id,
    MAX_CONVERSATIONS_PER_SESSION,
  );
  return rows.map((row) => toConversationDto(row, assistantFor(visitor, row)));
}

export async function getVisitorConversation(visitor: VisitorContext, conversationId: string) {
  const conversation = await requireOwned(visitor, conversationId);
  const messages = await visitorConversationsRepository.messages(
    visitor.organizationId,
    conversation.id,
    MAX_VISIBLE_MESSAGES,
  );
  return {
    conversation: toConversationDto(conversation, assistantFor(visitor, conversation)),
    messages: messages.map(toMessageDto),
  };
}

// ---- customer identity -------------------------------------------------------------------------

function splitName(
  name: string | undefined,
): { firstName: string; lastName: string | null } | null {
  const clean = name ? collapseWhitespace(name) : "";
  if (!clean) return null;
  const [first, ...rest] = clean.split(" ");
  return { firstName: first.slice(0, 100), lastName: rest.join(" ").slice(0, 100) || null };
}

/**
 * The customer a visitor's conversations belong to. DETERMINED BY THE SERVER, never by the client:
 * an anonymous visitor gets a placeholder customer ("Website visitor", source web_chat) the first
 * time it needs one, and is linked to a real organization customer only through its email
 * (see `identifyVisitor`).
 */
export async function ensureVisitorCustomer(visitor: VisitorContext): Promise<string> {
  const { session, organizationId } = visitor;
  if (session.customerId) return session.customerId;

  const name = splitName(session.visitorName ?? undefined);
  let customerId: string;
  try {
    const created = await customersRepository.create(organizationId, {
      externalId: null,
      firstName: name?.firstName ?? "Website visitor",
      lastName: name?.lastName ?? null,
      email: session.visitorEmail ?? null,
      phone: null,
      company: null,
      jobTitle: null,
      source: WEB_CHAT_SOURCE,
      status: "ACTIVE",
    });
    customerId = created.id;
    await emitDomainEvent({
      organizationId,
      actorUserId: null,
      type: "customer.created",
      data: { customerId, status: created.status, company: null, source: WEB_CHAT_SOURCE },
    });
  } catch (error) {
    // The visitor's email already belongs to a customer: reuse it (organization scoped).
    if (!isUniqueViolation(error) || !session.visitorEmail) throw error;
    const existing = await customersRepository.findByEmail(organizationId, session.visitorEmail);
    if (!existing) throw error;
    customerId = existing.id;
  }

  if (
    !(await visitorSessionsRepository.linkCustomerIfUnset(organizationId, session.id, customerId))
  ) {
    // A concurrent request linked the session first: use that customer.
    const fresh = await visitorSessionsRepository.findById(organizationId, session.id);
    if (fresh?.customerId) return fresh.customerId;
  }
  session.customerId = customerId;
  return customerId;
}

/**
 * A visitor tells us who they are. Deterministic, organization-scoped resolution:
 *
 *   email -> an existing customer of THIS organization? yes: link the session to it (the visitor
 *   gains no access to that customer's other data), no: use/enrich the visitor's own placeholder.
 *
 * Rules: a visitor can never choose a customer id; existing customers are never edited from visitor
 * input (only placeholders created by this widget are filled in); the email is unverified, so linking
 * only attaches THIS visitor's conversations to the customer record; archived customers are not linked.
 */
export async function identifyVisitor(visitor: VisitorContext, input: WidgetIdentityInput) {
  const { session, organizationId } = visitor;
  const name = splitName(input.name);

  await visitorSessionsRepository.setIdentity(organizationId, session.id, {
    ...(input.name ? { visitorName: collapseWhitespace(input.name) } : {}),
    ...(input.email ? { visitorEmail: input.email } : {}),
  });
  if (input.name) session.visitorName = collapseWhitespace(input.name);
  if (input.email) session.visitorEmail = input.email;

  let linkedToExisting = false;
  const current = session.customerId;

  if (input.email) {
    const found = await customersRepository.findByEmail(organizationId, input.email);
    if (found && found.id !== current) {
      const target = await customersRepository.findById(organizationId, found.id);
      if (target && target.status !== "ARCHIVED") {
        await visitorSessionsRepository.setIdentity(organizationId, session.id, {
          customerId: target.id,
        });
        session.customerId = target.id;
        await visitorConversationsRepository.moveToCustomer(organizationId, session.id, target.id);
        if (current) await archiveUnusedPlaceholder(organizationId, current);
        linkedToExisting = true;
      }
    } else if (!found) {
      if (current) {
        await fillPlaceholder(organizationId, current, { email: input.email, name });
      } else {
        await ensureVisitorCustomer(visitor); // creates with the email/name now stored on the session
      }
    }
  } else if (name && current) {
    await fillPlaceholder(organizationId, current, { email: null, name });
  }

  log.info(
    {
      organizationId,
      visitorSessionId: session.id,
      linkedToExisting,
      hasEmail: Boolean(input.email),
    },
    "visitor identified",
  );
  return { linkedToExisting };
}

/** Fills a placeholder customer created by THIS widget. Any other customer is left untouched. */
async function fillPlaceholder(
  organizationId: string,
  customerId: string,
  data: { email: string | null; name: { firstName: string; lastName: string | null } | null },
) {
  const customer = await customersRepository.findById(organizationId, customerId);
  if (!customer || customer.source !== WEB_CHAT_SOURCE) return;
  const changes: Record<string, unknown> = {};
  if (data.email && !customer.email) changes.email = data.email;
  if (data.name && customer.firstName === "Website visitor") {
    changes.firstName = data.name.firstName;
    changes.lastName = data.name.lastName;
  }
  if (Object.keys(changes).length === 0) return;
  try {
    const updated = await customersRepository.update(organizationId, customerId, changes);
    await emitDomainEvent({
      organizationId,
      actorUserId: null,
      type: "customer.updated",
      data: {
        customerId,
        status: updated.status,
        company: updated.company ?? null,
        changedFields: Object.keys(changes),
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error; // someone took the email meanwhile: keep the placeholder
  }
}

/** Archives the placeholder a visitor no longer needs (nothing else points at it). */
async function archiveUnusedPlaceholder(organizationId: string, customerId: string) {
  const customer = await customersRepository.findById(organizationId, customerId);
  if (!customer || customer.source !== WEB_CHAT_SOURCE || customer.email) return;
  const stillUsed = await visitorSessionsCountForCustomer(organizationId, customerId);
  if (stillUsed) return;
  await customersRepository.update(organizationId, customerId, {
    status: "ARCHIVED",
    archivedAt: new Date(),
  });
}

async function visitorSessionsCountForCustomer(organizationId: string, customerId: string) {
  const { getDb } = await import("@/db/client");
  const db = getDb();
  const [conversations, sessions] = await Promise.all([
    db.conversation.count({ where: { organizationId, customerId } }),
    db.visitorSession.count({ where: { organizationId, customerId } }),
  ]);
  return conversations > 0 || sessions > 0;
}

// ---- conversations and messages ----------------------------------------------------------------

function subjectFrom(body: string): string {
  const line = collapseWhitespace(body.split("\n")[0] ?? "");
  return (line.length > 80 ? `${line.slice(0, 77)}...` : line) || "Website chat";
}

/**
 * Starts a web chat conversation with the visitor's first message. Idempotent per
 * `clientMessageId`: a retried request returns the conversation that request already created.
 */
export async function createVisitorConversation(
  visitor: VisitorContext,
  input: { body: string; clientMessageId: string },
) {
  const { organizationId, session } = visitor;

  const existing = await findByClientMessage(organizationId, session.id, input.clientMessageId);
  if (existing) {
    const found = await getVisitorConversation(visitor, existing);
    // A retry also re-queues the AI reply, covering a crash between storing the message and queueing.
    await scheduleAiFor(visitor, found, input.clientMessageId);
    return { ...found, duplicate: true };
  }

  const count = await visitorConversationsRepository.countForSession(organizationId, session.id);
  if (count >= MAX_CONVERSATIONS_PER_SESSION) {
    throw new ConflictError("You have reached the maximum number of chats");
  }

  const customerId = await ensureVisitorCustomer(visitor);
  const conversation = await createConversationCore({
    organizationId,
    actor: { kind: "customer", visitorSessionId: session.id },
    visitorSessionId: session.id,
    clientMessageId: input.clientMessageId,
    input: {
      customerId,
      subject: subjectFrom(input.body),
      priority: "NORMAL",
      channel: "WEB_CHAT",
      initialMessage: { body: input.body, from: "CUSTOMER" },
    },
    // AI answers from the start only when customer AI is enabled for the organization.
    handlingMode: visitor.widget.aiEnabled ? "AI" : "HUMAN",
  });
  log.info(
    { organizationId, visitorSessionId: session.id, conversationId: conversation.id },
    "visitor conversation created",
  );
  const created = await getVisitorConversation(visitor, conversation.id);
  await scheduleAiFor(visitor, created, input.clientMessageId);
  return { ...created, duplicate: false };
}

/** Queues the customer-facing AI reply for the visitor message that carries this client id. */
async function scheduleAiFor(
  visitor: VisitorContext,
  conversation: { conversation: { id: string }; messages: VisitorMessageDto[] },
  clientMessageId: string,
) {
  const message = conversation.messages.find((m) => m.clientMessageId === clientMessageId);
  if (!message) return;
  await scheduleCustomerAiReply({
    organizationId: visitor.organizationId,
    conversationId: conversation.conversation.id,
    messageId: message.id,
    visitorSessionId: visitor.session.id,
  });
}

async function findByClientMessage(
  organizationId: string,
  visitorSessionId: string,
  clientMessageId: string,
) {
  const { getDb } = await import("@/db/client");
  const row = await getDb().message.findFirst({
    where: { organizationId, clientMessageId, conversation: { visitorSessionId } },
    select: { conversationId: true },
  });
  return row?.conversationId ?? null;
}

/**
 * A visitor message. The author is the visitor (the CUSTOMER), derived from the session, never from
 * input; ownership of the conversation is checked first. Same persistence path as staff messages.
 */
export async function sendVisitorMessage(
  visitor: VisitorContext,
  conversationId: string,
  input: { body: string; clientMessageId: string },
) {
  const conversation = await requireOwned(visitor, conversationId);
  const { message, duplicate } = await persistMessage({
    organizationId: visitor.organizationId,
    actor: { kind: "customer", visitorSessionId: visitor.session.id },
    conversationId: conversation.id,
    input: { body: input.body, type: "MESSAGE", from: "CUSTOMER" },
    clientMessageId: input.clientMessageId,
  });
  // Queue (or re-queue, for a retry) the assistant's answer; it never delays this response.
  await scheduleCustomerAiReply({
    organizationId: visitor.organizationId,
    conversationId: conversation.id,
    messageId: message.id,
    visitorSessionId: visitor.session.id,
  });
  return {
    duplicate,
    message: {
      id: message.id,
      from: "visitor" as const,
      body: message.body,
      createdAt: message.createdAt.toISOString(),
      clientMessageId: input.clientMessageId,
      authorName: null,
      handoffSuggested: false,
    } satisfies VisitorMessageDto,
  };
}

/**
 * "I'd like to talk to a person." Marks the conversation (once), records an audit event and tells
 * the inbox. A person then claims it with the normal assign flow, which clears the marker. No AI
 * reply is sent: Phase 7 keeps humans in the loop.
 */
export async function requestHuman(visitor: VisitorContext, conversationId: string) {
  const conversation = await requireOwned(visitor, conversationId);
  const requested = await markHumanRequested({
    organizationId: visitor.organizationId,
    conversationId: conversation.id,
    requester: { visitorSessionId: visitor.session.id },
  });
  return { humanRequested: true, alreadyRequested: !requested };
}
