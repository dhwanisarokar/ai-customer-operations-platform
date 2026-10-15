import {
  publishRecordedEvents,
  recordDomainEvent,
  type RecordedEvent,
} from "@/server/events/outbox";
import { transaction } from "@/db/client";
import type { Prisma } from "@/generated/prisma/client";
import { previewOf } from "@/features/conversations/transitions";
import type { ListMessagesQuery, SendMessageInput } from "@/features/conversations/schemas";
import { createLogger } from "@/lib/logger";
import type { Pagination } from "@/lib/query-params";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, ValidationError } from "@/server/errors";
import { toPage, toSkipTake } from "@/server/http/pagination";
import { conversationEventsRepository } from "@/server/repositories/conversation-events";
import { conversationMessagesRepository } from "@/server/repositories/conversation-messages";
import {
  conversationsRepository,
  type ConversationChanges,
} from "@/server/repositories/conversations";
import { toDeliveryDto, type MessageDeliveryDto } from "@/server/email/delivery-state";
import { outboundEmailRepository } from "@/server/repositories/outbound-email";
import { timestampSequence } from "./clock";
import { isUniqueViolation } from "@/db/errors";
import { NotFoundError } from "@/server/errors";
import { actorEvent, actorUserId, type Actor } from "./actors";
import { requireConversationState } from "./conversations";

const log = createLogger("conversation-messages");

/** The AI reply was not stored: the conversation is no longer in AI mode (or was resolved). */
export class AiReplyNotAllowedError extends ConflictError {
  constructor() {
    super("AI replies are not allowed for this conversation right now");
  }
}

/**
 * Adds a customer-facing message or an internal note. The sender is derived from the session:
 * a client can never name the author or the organization.
 *
 * Lifecycle rules:
 * - Agents cannot reply on a RESOLVED conversation (reopen it first); internal notes are always allowed.
 * - A customer message on a PENDING or RESOLVED conversation reopens it (event STATUS_CHANGED).
 * - Only customer-facing messages touch lastMessageAt / preview; internal notes never leak there.
 * - Message content is never written to logs or events, only ids and types.
 */
export async function sendMessage(
  ctx: OrganizationContext,
  conversationId: string,
  input: SendMessageInput,
) {
  ctx.require("send_messages");
  const { message } = await persistMessage({
    organizationId: ctx.organization.id,
    actor: { kind: "user", userId: ctx.user.id },
    conversationId,
    input,
  });
  return message;
}

/**
 * The one place a message is stored, for staff AND for web chat visitors. The caller has already
 * authorized the actor (RBAC for a user; ownership of the conversation for a visitor), so this
 * function only applies the conversation rules:
 *
 * - the author is derived from the actor, never from input (a visitor is always the CUSTOMER);
 * - `clientMessageId` makes a retried send idempotent (the first message wins, no duplicate);
 * - one transaction writes message, conversation preview/status and events; domain events are
 *   emitted after it commits.
 */
export type PersistMessageParams = {
  organizationId: string;
  actor: Actor;
  conversationId: string;
  input: SendMessageInput;
  clientMessageId?: string;
  /** AI replies only: provenance shown to staff (never to visitors). */
  metadata?: Prisma.InputJsonValue;
  /**
   * AI actor only (default true): the reply is stored only if the conversation is in AI mode and not
   * resolved, checked atomically in the same transaction. The fixed handoff acknowledgement passes
   * false: it announces the switch to HUMAN.
   */
  requireAiMode?: boolean;
  /**
   * Set ONLY by `createOutboundReply`, which stores the message together with its outbound email. A customer-facing
   * staff message on an EMAIL conversation is refused without it (see below).
   */
  emailReply?: boolean;
};

type MessageRow = Awaited<ReturnType<typeof conversationMessagesRepository.create>>;

/** What a stored message leaves for the caller to announce once the transaction has committed. */
export type PersistedMessage = {
  message: MessageRow;
  customerId: string;
  /** The status the conversation was reopened from (customer message on PENDING/RESOLVED), if any. */
  reopenedFrom: string | null;
  priority: string;
  assignee: string | null;
  /**
   * The domain events of this message, recorded in the SAME transaction (durable): `message.created` and, when
   * the conversation was reopened, `conversation.status_changed`. Published after the commit.
   */
  events: RecordedEvent[];
};

export async function persistMessage(params: PersistMessageParams): Promise<{
  message: MessageRow;
  duplicate: boolean;
}> {
  const { organizationId, conversationId, clientMessageId } = params;
  let persisted: PersistedMessage;
  try {
    persisted = await transaction((tx) => persistMessageInTransaction(tx, params));
  } catch (error) {
    // A concurrent retry of the same client message won the race: return that one.
    if (clientMessageId && isUniqueViolation(error)) {
      const existing = await conversationMessagesRepository.findByClientMessageId(
        organizationId,
        conversationId,
        clientMessageId,
      );
      if (existing) return { message: existing, duplicate: true };
    }
    throw error;
  }
  await announcePersistedMessage(params, persisted);
  return { message: persisted.message, duplicate: false };
}

/**
 * The transactional part of `persistMessage`, for callers that must store a message together with other
 * rows atomically (email ingestion stores the message, its email headers and the replay record in ONE
 * transaction). The rules are exactly those of `persistMessage`. The caller MUST call
 * `announcePersistedMessage` after its transaction has committed (never before, never on rollback).
 */
export async function persistMessageInTransaction(
  tx: Prisma.TransactionClient,
  params: PersistMessageParams,
): Promise<PersistedMessage> {
  const { organizationId, actor, conversationId, input, clientMessageId, metadata } = params;
  const requireAiMode = params.requireAiMode ?? true;
  const userId = actorUserId(actor);
  const isNote = input.type === "INTERNAL_NOTE";
  const fromAi = actor.kind === "ai";
  const fromCustomer = !fromAi && input.from === "CUSTOMER";

  // An AI reply first takes the conversation row with the eligibility in the UPDATE itself: a
  // concurrent switch to HUMAN / assignment / resolve either committed before (nothing matches, the
  // reply is discarded) or waits for this transaction.
  if (fromAi && requireAiMode) {
    if (!(await conversationsRepository.claimForAiReply(organizationId, conversationId, tx))) {
      throw new AiReplyNotAllowedError();
    }
  }
  // Read-modify-write of status and previews: take the row first so concurrent messages are applied in turn.
  await conversationsRepository.lock(organizationId, conversationId, tx);
  const state = await conversationsRepository.findState(organizationId, conversationId, tx);
  if (!state) throw new NotFoundError("Conversation not found");
  if (!isNote && !fromCustomer && state.status === "RESOLVED") {
    throw new ConflictError("This conversation is resolved. Reopen it before replying.");
  }
  // A customer-facing reply from a staff member on an email conversation MUST be an email. Storing it without sending
  // would show the team a reply the customer never receives, so the plain message path refuses it; internal notes and
  // logged customer messages are unaffected, as is every other channel.
  if (
    state.channel === "EMAIL" &&
    actor.kind === "user" &&
    !isNote &&
    !fromCustomer &&
    !params.emailReply
  ) {
    throw new ConflictError("This is an email conversation: send replies by email.");
  }

  const next = timestampSequence();
  const now = next();
  const created = await conversationMessagesRepository.create(
    organizationId,
    conversationId,
    {
      senderType: fromAi ? "AI_AGENT" : fromCustomer ? "CUSTOMER" : "USER",
      senderUserId: fromCustomer || fromAi ? null : userId,
      ...(metadata ? { metadata } : {}),
      messageType: input.type,
      body: input.body,
      clientMessageId: clientMessageId ?? null,
      createdAt: now,
    },
    tx,
  );

  const changes: ConversationChanges = {};
  if (!isNote) {
    changes.lastMessageAt = now;
    changes.lastMessagePreview = previewOf(input.body);
    changes.lastMessageSenderType = created.senderType;
    if (fromCustomer) changes.lastCustomerMessageAt = now;
  }
  // A staff reply takes over a conversation the AI was handling (explicit rule; the agent can switch
  // back to AI afterwards). A visitor message that reopens a conversation never changes the mode.
  const takesOver = !isNote && !fromCustomer && !fromAi && state.handlingMode === "AI";
  if (takesOver) changes.handlingMode = "HUMAN";
  const reopens = fromCustomer && (state.status === "PENDING" || state.status === "RESOLVED");
  if (reopens) {
    changes.status = "OPEN";
    changes.closedAt = null;
  }
  await conversationsRepository.update(organizationId, conversationId, changes, tx);

  await conversationEventsRepository.record(
    organizationId,
    conversationId,
    {
      type: isNote ? "INTERNAL_NOTE_ADDED" : "MESSAGE_SENT",
      metadata: { messageId: created.id, senderType: created.senderType },
      createdAt: next(),
      ...actorEvent(actor),
    },
    tx,
  );
  if (takesOver) {
    await conversationEventsRepository.record(
      organizationId,
      conversationId,
      {
        type: "HANDLING_MODE_CHANGED",
        metadata: { from: "AI", to: "HUMAN", reason: "agent_replied" },
        createdAt: next(),
        ...actorEvent(actor),
      },
      tx,
    );
  }
  if (reopens) {
    await conversationEventsRepository.record(
      organizationId,
      conversationId,
      {
        type: "STATUS_CHANGED",
        metadata: { from: state.status, to: "OPEN", reason: "customer_message" },
        createdAt: next(),
        ...actorEvent(actor),
      },
      tx,
    );
  }

  // A staff sender has obviously seen the conversation up to this point (visitors have no read state).
  if (userId)
    await conversationsRepository.markRead(organizationId, conversationId, userId, next(), tx);

  const events: RecordedEvent[] = [
    await recordDomainEvent(tx, {
      organizationId,
      actorUserId: userId,
      type: "message.created",
      data: {
        messageId: created.id,
        conversationId,
        customerId: state.customerId,
        senderType: created.senderType,
        messageType: created.messageType,
        body: input.body,
      },
    }),
  ];
  if (reopens) {
    events.push(
      await recordDomainEvent(tx, {
        organizationId,
        actorUserId: userId,
        type: "conversation.status_changed",
        data: {
          conversationId,
          customerId: state.customerId,
          status: "OPEN",
          previousStatus: state.status,
          priority: state.priority,
          assignee: state.assignedToUserId,
        },
      }),
    );
  }
  return {
    message: created,
    customerId: state.customerId,
    reopenedFrom: reopens ? state.status : null,
    priority: state.priority,
    assignee: state.assignedToUserId,
    events,
  };
}

/**
 * After the commit: logs and publishes the events that `persistMessageInTransaction` recorded. Publishing
 * never throws; an event that could not be published stays in the outbox and is retried.
 */
export async function announcePersistedMessage(
  params: Pick<PersistMessageParams, "organizationId" | "actor" | "conversationId" | "input">,
  persisted: PersistedMessage,
): Promise<void> {
  const { organizationId, actor, conversationId, input } = params;
  log.info(
    {
      organizationId,
      conversationId,
      messageId: persisted.message.id,
      actor: actor.kind,
      type: input.type,
    },
    "message added",
  );
  await publishRecordedEvents(persisted.events);
}

/**
 * Newest-first cursor pagination returned chronologically. Internal notes are excluded unless
 * `includeInternal` is requested explicitly.
 */
export async function listMessages(
  ctx: OrganizationContext,
  conversationId: string,
  query: ListMessagesQuery,
) {
  ctx.require("view_conversations");
  const organizationId = ctx.organization.id;
  const state = await requireConversationState(ctx, conversationId);

  if (query.before) {
    // The cursor must be a message of this very conversation in this organization.
    if (
      !(await conversationMessagesRepository.exists(organizationId, conversationId, query.before))
    ) {
      throw new ValidationError("Invalid cursor");
    }
  }

  const { items, hasMore, total } = await conversationMessagesRepository.page(
    organizationId,
    conversationId,
    { limit: query.limit, before: query.before, includeInternal: query.includeInternal },
  );
  return {
    items: await withDelivery(organizationId, conversationId, state.channel, items),
    hasMore,
    nextCursor: hasMore ? (items[0]?.id ?? null) : null,
    total,
  };
}

export type MessageWithDelivery = MessageRow & { emailDelivery?: MessageDeliveryDto | null };

/**
 * Attaches the persisted delivery state (`emailDelivery`) of outbound emails to the messages of an EMAIL conversation. Other channels
 * get no `delivery` at all, so their payloads are exactly what they were. One organization- and conversation-scoped
 * query; nothing is read for a conversation that is not an email conversation.
 */
async function withDelivery(
  organizationId: string,
  conversationId: string,
  channel: string,
  items: MessageRow[],
): Promise<MessageWithDelivery[]> {
  if (channel !== "EMAIL") return items;
  const rows = await outboundEmailRepository.deliveryForMessages(
    organizationId,
    conversationId,
    items.map((item) => item.id),
  );
  const byMessage = new Map(rows.map((row) => [row.messageId, toDeliveryDto(row)]));
  return items.map((item) => ({ ...item, emailDelivery: byMessage.get(item.id) ?? null }));
}

export async function listConversationEvents(
  ctx: OrganizationContext,
  conversationId: string,
  pagination: Pagination,
) {
  ctx.require("view_conversations");
  await requireConversationState(ctx, conversationId);
  const { items, total } = await conversationEventsRepository.page(
    ctx.organization.id,
    conversationId,
    toSkipTake(pagination),
  );
  return toPage(items, total, pagination);
}

/**
 * Everything the detail view renders: the latest `limit` messages (including internal notes, for
 * staff) plus the audit events that fall inside the same time window, so the two interleave
 * correctly without loading the whole history.
 */
export async function getConversationTimeline(
  ctx: OrganizationContext,
  conversationId: string,
  limit = 50,
) {
  ctx.require("view_conversations");
  const organizationId = ctx.organization.id;
  await requireConversationState(ctx, conversationId);

  const messages = await conversationMessagesRepository.page(organizationId, conversationId, {
    limit,
    includeInternal: true,
  });
  const since = messages.hasMore ? messages.items[0]?.createdAt : undefined;
  const events = await conversationEventsRepository.list(organizationId, conversationId, {
    since,
    take: 500,
  });
  return { messages: messages.items, events, hasMore: messages.hasMore, total: messages.total };
}
