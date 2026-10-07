import { transaction } from "@/db/client";
import { canTransition, previewOf } from "@/features/conversations/transitions";
import type {
  CreateConversationInput,
  ListConversationsQuery,
  UpdateConversationInput,
} from "@/features/conversations/schemas";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { timestampSequence } from "./clock";
import { toPage, type Page } from "@/server/http/pagination";
import { conversationEventsRepository } from "@/server/repositories/conversation-events";
import { conversationMessagesRepository } from "@/server/repositories/conversation-messages";
import {
  conversationsRepository,
  type ConversationChanges,
  type ConversationDto,
  type ConversationState,
} from "@/server/repositories/conversations";
import { customersRepository } from "@/server/repositories/customers";
import type { Prisma } from "@/generated/prisma/client";

const log = createLogger("conversations");

export function eventActor(ctx: OrganizationContext) {
  return { actorType: "USER" as const, actorId: ctx.user.id };
}

/**
 * Resolves a conversation inside the caller's organization or throws 404. A conversation id that
 * exists in another organization is indistinguishable from one that does not exist.
 */
export async function requireConversationState(
  ctx: OrganizationContext,
  conversationId: string,
  db?: Parameters<typeof conversationsRepository.findState>[2],
): Promise<ConversationState> {
  const state = await conversationsRepository.findState(ctx.organization.id, conversationId, db);
  if (!state) throw new NotFoundError("Conversation not found");
  return state;
}

export async function createConversation(
  ctx: OrganizationContext,
  input: CreateConversationInput,
): Promise<ConversationDto> {
  ctx.require("create_conversations");
  const organizationId = ctx.organization.id;

  const conversation = await transaction(async (tx) => {
    // The customer must belong to the caller's organization (the composite FK also guarantees it).
    const customer = await customersRepository.findById(organizationId, input.customerId, tx);
    if (!customer) throw new NotFoundError("Customer not found");
    if (customer.status === "ARCHIVED") {
      throw new ConflictError("Archived customers cannot start new conversations");
    }

    const next = timestampSequence();
    const createdAt = next();
    const messageAt = next();
    const first = input.initialMessage;
    const fromCustomer = first?.from === "CUSTOMER";

    const created = await conversationsRepository.create(
      organizationId,
      {
        customerId: customer.id,
        subject: input.subject,
        priority: input.priority,
        channel: input.channel,
        lastMessageAt: first ? messageAt : createdAt,
        lastMessagePreview: first ? previewOf(first.body) : null,
        lastMessageSenderType: first ? (fromCustomer ? "CUSTOMER" : "USER") : null,
        lastCustomerMessageAt: fromCustomer ? messageAt : null,
      },
      ctx.user.id,
      tx,
    );

    await conversationEventsRepository.record(
      organizationId,
      created.id,
      {
        type: "CONVERSATION_CREATED",
        metadata: { customerId: customer.id, priority: input.priority, channel: input.channel },
        createdAt,
        ...eventActor(ctx),
      },
      tx,
    );

    if (first) {
      const message = await conversationMessagesRepository.create(
        organizationId,
        created.id,
        {
          senderType: fromCustomer ? "CUSTOMER" : "USER",
          senderUserId: fromCustomer ? null : ctx.user.id,
          messageType: "MESSAGE",
          body: first.body,
          createdAt: messageAt,
        },
        tx,
      );
      await conversationEventsRepository.record(
        organizationId,
        created.id,
        {
          type: "MESSAGE_SENT",
          metadata: { messageId: message.id, senderType: message.senderType },
          createdAt: next(),
          ...eventActor(ctx),
        },
        tx,
      );
    }

    // The creator has just seen everything in it.
    await conversationsRepository.markRead(organizationId, created.id, ctx.user.id, next(), tx);
    return (await conversationsRepository.findById(organizationId, created.id, ctx.user.id, tx))!;
  });

  log.info(
    { organizationId, conversationId: conversation.id, actorId: ctx.user.id },
    "conversation created",
  );
  return conversation;
}

export async function getConversation(
  ctx: OrganizationContext,
  conversationId: string,
): Promise<ConversationDto> {
  ctx.require("view_conversations");
  const conversation = await conversationsRepository.findById(
    ctx.organization.id,
    conversationId,
    ctx.user.id,
  );
  if (!conversation) throw new NotFoundError("Conversation not found");
  return conversation;
}

export async function listConversations(
  ctx: OrganizationContext,
  query: ListConversationsQuery,
): Promise<Page<ConversationDto>> {
  ctx.require("view_conversations");
  const { items, total } = await conversationsRepository.list(
    ctx.organization.id,
    ctx.user.id,
    query,
  );
  return toPage(items, total, query);
}

/** Latest conversations of one customer, for the Customer 360 page. */
export async function listCustomerConversations(
  ctx: OrganizationContext,
  customerId: string,
  take = 5,
) {
  ctx.require("view_conversations");
  return conversationsRepository.listForCustomer(
    ctx.organization.id,
    customerId,
    ctx.user.id,
    take,
  );
}

/** Subject, status and priority. Every real change is validated and written to the event log. */
export async function updateConversation(
  ctx: OrganizationContext,
  conversationId: string,
  input: UpdateConversationInput,
): Promise<ConversationDto> {
  ctx.require("update_conversations");
  const organizationId = ctx.organization.id;

  return transaction(async (tx) => {
    const current = await requireConversationState(ctx, conversationId, tx);
    const next = timestampSequence();
    const now = next();
    const changes: ConversationChanges = {};
    const events: {
      type: "SUBJECT_CHANGED" | "PRIORITY_CHANGED" | "STATUS_CHANGED";
      metadata: Prisma.InputJsonValue;
    }[] = [];

    if (input.subject !== undefined && input.subject !== current.subject) {
      changes.subject = input.subject;
      events.push({
        type: "SUBJECT_CHANGED",
        metadata: { from: current.subject, to: input.subject },
      });
    }
    if (input.priority !== undefined && input.priority !== current.priority) {
      changes.priority = input.priority;
      events.push({
        type: "PRIORITY_CHANGED",
        metadata: { from: current.priority, to: input.priority },
      });
    }
    if (input.status !== undefined && input.status !== current.status) {
      if (!canTransition(current.status, input.status)) {
        throw new ConflictError(`Cannot change status from ${current.status} to ${input.status}`);
      }
      changes.status = input.status;
      changes.closedAt = input.status === "RESOLVED" ? now : null;
      events.push({ type: "STATUS_CHANGED", metadata: { from: current.status, to: input.status } });
    }

    if (events.length > 0) {
      await conversationsRepository.update(organizationId, conversationId, changes, tx);
      for (const event of events) {
        await conversationEventsRepository.record(
          organizationId,
          conversationId,
          { ...event, createdAt: next(), ...eventActor(ctx) },
          tx,
        );
      }
      log.info(
        { organizationId, conversationId, actorId: ctx.user.id, events: events.map((e) => e.type) },
        "conversation updated",
      );
    }
    return (await conversationsRepository.findById(
      organizationId,
      conversationId,
      ctx.user.id,
      tx,
    ))!;
  });
}

/**
 * Admins (assign_conversations) may assign anyone. Members may only claim an unassigned
 * conversation for themselves. The assignee must be a member of this organization (also enforced
 * by a composite foreign key).
 */
export async function assignConversation(
  ctx: OrganizationContext,
  conversationId: string,
  assigneeId: string,
): Promise<ConversationDto> {
  ctx.require("view_conversations");
  const organizationId = ctx.organization.id;
  const canAssignOthers = ctx.can("assign_conversations");

  return transaction(async (tx) => {
    const current = await requireConversationState(ctx, conversationId, tx);

    if (!canAssignOthers) {
      const claimingForSelf = assigneeId === ctx.user.id;
      const free = current.assignedToUserId === null || current.assignedToUserId === ctx.user.id;
      if (!claimingForSelf || !free) throw new ForbiddenError();
    }
    if (!(await conversationsRepository.isMember(organizationId, assigneeId, tx))) {
      throw new NotFoundError("Member not found");
    }

    if (current.assignedToUserId !== assigneeId) {
      const now = new Date();
      await conversationsRepository.update(
        organizationId,
        conversationId,
        { assignedToUserId: assigneeId },
        tx,
      );
      await conversationEventsRepository.record(
        organizationId,
        conversationId,
        {
          type: "ASSIGNED",
          metadata: { from: current.assignedToUserId, to: assigneeId },
          createdAt: now,
          ...eventActor(ctx),
        },
        tx,
      );
      log.info(
        { organizationId, conversationId, actorId: ctx.user.id, assigneeId },
        "conversation assigned",
      );
    }
    return (await conversationsRepository.findById(
      organizationId,
      conversationId,
      ctx.user.id,
      tx,
    ))!;
  });
}

export async function unassignConversation(
  ctx: OrganizationContext,
  conversationId: string,
): Promise<ConversationDto> {
  ctx.require("view_conversations");
  const organizationId = ctx.organization.id;

  return transaction(async (tx) => {
    const current = await requireConversationState(ctx, conversationId, tx);
    if (current.assignedToUserId !== null) {
      if (!ctx.can("assign_conversations") && current.assignedToUserId !== ctx.user.id) {
        throw new ForbiddenError();
      }
      await conversationsRepository.update(
        organizationId,
        conversationId,
        { assignedToUserId: null },
        tx,
      );
      await conversationEventsRepository.record(
        organizationId,
        conversationId,
        { type: "UNASSIGNED", metadata: { from: current.assignedToUserId }, ...eventActor(ctx) },
        tx,
      );
      log.info({ organizationId, conversationId, actorId: ctx.user.id }, "conversation unassigned");
    }
    return (await conversationsRepository.findById(
      organizationId,
      conversationId,
      ctx.user.id,
      tx,
    ))!;
  });
}

/** Per-member read marker. Opening a conversation clears its unread indicator for that member only. */
export async function markConversationRead(ctx: OrganizationContext, conversationId: string) {
  ctx.require("view_conversations");
  await requireConversationState(ctx, conversationId);
  await conversationsRepository.markRead(
    ctx.organization.id,
    conversationId,
    ctx.user.id,
    new Date(),
  );
}
