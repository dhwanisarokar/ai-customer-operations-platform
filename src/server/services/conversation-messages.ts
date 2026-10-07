import { transaction } from "@/db/client";
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
import { eventActor, requireConversationState } from "./conversations";

const log = createLogger("conversation-messages");

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
  const organizationId = ctx.organization.id;
  const isNote = input.type === "INTERNAL_NOTE";
  const fromCustomer = input.from === "CUSTOMER";

  const message = await transaction(async (tx) => {
    const state = await requireConversationState(ctx, conversationId, tx);
    if (!isNote && !fromCustomer && state.status === "RESOLVED") {
      throw new ConflictError("This conversation is resolved. Reopen it before replying.");
    }

    const next = timestampSequence();
    const now = next();
    const created = await conversationMessagesRepository.create(
      organizationId,
      conversationId,
      {
        senderType: fromCustomer ? "CUSTOMER" : "USER",
        senderUserId: fromCustomer ? null : ctx.user.id,
        messageType: input.type,
        body: input.body,
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
        ...eventActor(ctx),
      },
      tx,
    );
    if (reopens) {
      await conversationEventsRepository.record(
        organizationId,
        conversationId,
        {
          type: "STATUS_CHANGED",
          metadata: { from: state.status, to: "OPEN", reason: "customer_message" },
          createdAt: next(),
          ...eventActor(ctx),
        },
        tx,
      );
    }

    // The sender has obviously seen the conversation up to this point.
    await conversationsRepository.markRead(organizationId, conversationId, ctx.user.id, next(), tx);
    return created;
  });

  log.info(
    {
      organizationId,
      conversationId,
      messageId: message.id,
      actorId: ctx.user.id,
      type: input.type,
    },
    "message added",
  );
  return message;
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
