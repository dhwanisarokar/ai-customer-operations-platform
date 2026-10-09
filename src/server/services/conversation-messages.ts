import { emitDomainEvent } from "@/server/events/bus";
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
export async function persistMessage(params: {
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
}): Promise<{
  message: Awaited<ReturnType<typeof conversationMessagesRepository.create>>;
  duplicate: boolean;
}> {
  const { organizationId, actor, conversationId, input, clientMessageId, metadata } = params;
  const requireAiMode = params.requireAiMode ?? true;
  const userId = actorUserId(actor);
  const isNote = input.type === "INTERNAL_NOTE";
  const fromAi = actor.kind === "ai";
  const fromCustomer = !fromAi && input.from === "CUSTOMER";

  let customerId = "";
  let reopenedFrom: string | null = null;
  let statePriority = "";
  let stateAssignee: string | null = null;
  let message: Awaited<ReturnType<typeof conversationMessagesRepository.create>>;
  try {
    message = await transaction(async (tx) => {
      // An AI reply first takes the conversation row with the eligibility in the UPDATE itself: a
      // concurrent switch to HUMAN / assignment / resolve either committed before (nothing matches, the
      // reply is discarded) or waits for this transaction.
      if (fromAi && requireAiMode) {
        if (!(await conversationsRepository.claimForAiReply(organizationId, conversationId, tx))) {
          throw new AiReplyNotAllowedError();
        }
      }
      const state = await conversationsRepository.findState(organizationId, conversationId, tx);
      if (!state) throw new NotFoundError("Conversation not found");
      customerId = state.customerId;
      statePriority = state.priority;
      stateAssignee = state.assignedToUserId;
      if (!isNote && !fromCustomer && state.status === "RESOLVED") {
        throw new ConflictError("This conversation is resolved. Reopen it before replying.");
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
        reopenedFrom = state.status;
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
      return created;
    });
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

  log.info(
    {
      organizationId,
      conversationId,
      messageId: message.id,
      actor: actor.kind,
      type: input.type,
    },
    "message added",
  );
  await emitDomainEvent({
    organizationId,
    actorUserId: userId,
    type: "message.created",
    data: {
      messageId: message.id,
      conversationId,
      customerId,
      senderType: message.senderType,
      messageType: message.messageType,
      body: input.body,
    },
  });
  if (reopenedFrom) {
    await emitDomainEvent({
      organizationId,
      actorUserId: userId,
      type: "conversation.status_changed",
      data: {
        conversationId,
        customerId,
        status: "OPEN",
        previousStatus: reopenedFrom,
        priority: statePriority,
        assignee: stateAssignee,
      },
    });
  }
  return { message, duplicate: false };
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
  await requireConversationState(ctx, conversationId);

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
  return { items, hasMore, nextCursor: hasMore ? (items[0]?.id ?? null) : null, total };
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
