import { getDb, type Db } from "@/db/client";
import type {
  ConversationChannel,
  ConversationHandlingMode,
  ConversationPriority,
  ConversationStatus,
  MessageSenderType,
  Prisma,
} from "@/generated/prisma/client";
import { fullName } from "@/features/customers/normalize";
import type { ListConversationsQuery } from "@/features/conversations/schemas";
import { escapeLike, searchTokens } from "./search";

/**
 * Tenant rule for this file: every function takes `organizationId` and puts it in the WHERE clause
 * (or the composite `id_organizationId` key). There is no lookup by id alone.
 */

// One select serves the inbox list and the detail header. The member's own read state rides along
// as a filtered relation, which Prisma loads in a single batched query (no per-row queries).
function conversationSelect(userId: string) {
  return {
    id: true,
    subject: true,
    status: true,
    priority: true,
    channel: true,
    lastMessageAt: true,
    lastMessagePreview: true,
    lastMessageSenderType: true,
    lastCustomerMessageAt: true,
    humanRequestedAt: true,
    handlingMode: true,
    createdAt: true,
    updatedAt: true,
    closedAt: true,
    customer: {
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        company: true,
        status: true,
      },
    },
    assignee: { select: { user: { select: { id: true, name: true, email: true } } } },
    readStates: { where: { userId }, select: { lastReadAt: true } },
  } satisfies Prisma.ConversationSelect;
}

type Row = Prisma.ConversationGetPayload<{ select: ReturnType<typeof conversationSelect> }>;

export type ConversationDto = {
  id: string;
  subject: string;
  status: ConversationStatus;
  priority: ConversationPriority;
  channel: ConversationChannel;
  customer: {
    id: string;
    name: string;
    email: string | null;
    company: string | null;
    status: string;
  };
  assignee: { id: string; name: string | null; email: string } | null;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  lastMessageSenderType: MessageSenderType | null;
  /** True when the customer wrote something this member has not opened yet. */
  unread: boolean;
  /** Set while a web chat visitor is waiting for a person (cleared when someone is assigned). */
  humanRequestedAt: Date | null;
  /** Who may answer the visitor of a web chat: the customer-facing AI or only people. */
  handlingMode: ConversationHandlingMode;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
};

export function toConversationDto(row: Row): ConversationDto {
  const readAt = row.readStates[0]?.lastReadAt ?? null;
  return {
    id: row.id,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    channel: row.channel,
    customer: {
      id: row.customer.id,
      name: fullName(row.customer),
      email: row.customer.email,
      company: row.customer.company,
      status: row.customer.status,
    },
    assignee: row.assignee?.user ?? null,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageSenderType: row.lastMessageSenderType,
    unread:
      row.lastCustomerMessageAt !== null && (readAt === null || row.lastCustomerMessageAt > readAt),
    humanRequestedAt: row.humanRequestedAt,
    handlingMode: row.handlingMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt,
  };
}

export type ConversationState = {
  id: string;
  customerId: string;
  subject: string;
  status: ConversationStatus;
  priority: ConversationPriority;
  assignedToUserId: string | null;
  handlingMode: ConversationHandlingMode;
};

const stateSelect = {
  id: true,
  customerId: true,
  subject: true,
  status: true,
  priority: true,
  assignedToUserId: true,
  handlingMode: true,
} as const;

export type NewConversation = {
  customerId: string;
  subject: string;
  priority: ConversationPriority;
  channel: ConversationChannel;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  lastMessageSenderType: MessageSenderType | null;
  lastCustomerMessageAt: Date | null;
  /** Web chat only: the visitor session that owns the conversation. */
  visitorSessionId?: string | null;
  /** Defaults to HUMAN. Web chat starts in AI mode when customer AI is enabled for the organization. */
  handlingMode?: ConversationHandlingMode;
};

export type ConversationChanges = Partial<{
  subject: string;
  status: ConversationStatus;
  priority: ConversationPriority;
  closedAt: Date | null;
  assignedToUserId: string | null;
  lastMessageAt: Date;
  lastMessagePreview: string | null;
  lastMessageSenderType: MessageSenderType | null;
  lastCustomerMessageAt: Date;
  humanRequestedAt: Date | null;
  handlingMode: ConversationHandlingMode;
}>;

export const conversationsRepository = {
  /** The composite foreign key rejects a customer that belongs to another organization. */
  async create(
    organizationId: string,
    data: NewConversation,
    userId: string,
    db: Db = getDb(),
  ): Promise<ConversationDto> {
    const row = await db.conversation.create({
      data: { ...data, organizationId },
      select: conversationSelect(userId),
    });
    return toConversationDto(row);
  },

  async findById(
    organizationId: string,
    id: string,
    userId: string,
    db: Db = getDb(),
  ): Promise<ConversationDto | null> {
    const row = await db.conversation.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: conversationSelect(userId),
    });
    return row ? toConversationDto(row) : null;
  },

  /** The visitor session that owns a web chat conversation (null for staff-created ones). */
  async visitorSessionIdOf(
    organizationId: string,
    id: string,
    db: Db = getDb(),
  ): Promise<string | null> {
    const row = await db.conversation.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: { visitorSessionId: true },
    });
    return row?.visitorSessionId ?? null;
  },

  /**
   * The atomic gate for an AI reply, called FIRST in the transaction that stores it. It is one UPDATE
   * with the eligibility in its WHERE (AI mode, not resolved): PostgreSQL takes the row lock, and if a
   * concurrent change (an agent switching to HUMAN, assigning, resolving) committed first, the
   * predicate is re-evaluated on the new row and matches nothing. True = this transaction now holds the
   * row and may insert the reply; any later mode change waits for it.
   */
  async claimForAiReply(organizationId: string, id: string, db: Db = getDb()): Promise<boolean> {
    const result = await db.conversation.updateMany({
      where: { id, organizationId, handlingMode: "AI", status: { not: "RESOLVED" } },
      data: { updatedAt: new Date() },
    });
    return result.count === 1;
  },

  /** Who else must hear about a change: the web chat visitor session and/or the portal customer. */
  async audienceOf(
    organizationId: string,
    id: string,
    db: Db = getDb(),
  ): Promise<{ visitorSessionId: string | null; portalCustomerId: string | null }> {
    const row = await db.conversation.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: { visitorSessionId: true, channel: true, customerId: true },
    });
    return {
      visitorSessionId: row?.visitorSessionId ?? null,
      portalCustomerId: row?.channel === "PORTAL" ? row.customerId : null,
    };
  },

  /** Lightweight state used by write paths (no joins). */
  findState(
    organizationId: string,
    id: string,
    db: Db = getDb(),
  ): Promise<ConversationState | null> {
    return db.conversation.findUnique({
      where: { id_organizationId: { id, organizationId } },
      select: stateSelect,
    });
  },

  async update(
    organizationId: string,
    id: string,
    changes: ConversationChanges,
    db: Db = getDb(),
  ): Promise<void> {
    await db.conversation.update({
      where: { id_organizationId: { id, organizationId } },
      data: { ...changes, updatedAt: new Date() },
    });
  },

  async list(
    organizationId: string,
    userId: string,
    query: ListConversationsQuery,
    db: Db = getDb(),
  ): Promise<{ items: ConversationDto[]; total: number }> {
    const where = buildWhere(organizationId, userId, query);
    const [rows, total] = await Promise.all([
      db.conversation.findMany({
        where,
        orderBy: [{ [query.sort]: query.order }, { id: query.order }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: conversationSelect(userId),
      }),
      db.conversation.count({ where }),
    ]);
    return { items: rows.map(toConversationDto), total };
  },

  async listForCustomer(
    organizationId: string,
    customerId: string,
    userId: string,
    take: number,
    db: Db = getDb(),
  ): Promise<{ items: ConversationDto[]; total: number }> {
    const where = { organizationId, customerId };
    const [rows, total] = await Promise.all([
      db.conversation.findMany({
        where,
        orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
        take,
        select: conversationSelect(userId),
      }),
      db.conversation.count({ where }),
    ]);
    return { items: rows.map(toConversationDto), total };
  },

  /** Marks the conversation as read by this member up to `at`. Never moves the marker backwards. */
  async markRead(
    organizationId: string,
    conversationId: string,
    userId: string,
    at: Date,
    db: Db = getDb(),
  ): Promise<void> {
    // Advance only: a late or out-of-order request must not un-read newer activity.
    const advanced = await db.conversationReadState.updateMany({
      where: { conversationId, userId, organizationId, lastReadAt: { lt: at } },
      data: { lastReadAt: at },
    });
    if (advanced.count === 0) {
      // Either no row yet (create it) or one that is already newer (skipDuplicates keeps it).
      await db.conversationReadState.createMany({
        data: [{ organizationId, conversationId, userId, lastReadAt: at }],
        skipDuplicates: true,
      });
    }
  },

  /** Tenant check for assignment: is this user a member of this organization? */
  async isMember(organizationId: string, userId: string, db: Db = getDb()): Promise<boolean> {
    const membership = await db.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { id: true },
    });
    return membership !== null;
  },

  /** Unassigns every conversation of a member (used when they leave the organization). */
  async unassignAllForUser(organizationId: string, userId: string, db: Db = getDb()) {
    const affected = await db.conversation.findMany({
      where: { organizationId, assignedToUserId: userId },
      select: { id: true },
    });
    if (affected.length === 0) return [];
    await db.conversation.updateMany({
      where: { organizationId, assignedToUserId: userId },
      data: { assignedToUserId: null, updatedAt: new Date() },
    });
    return affected.map((row) => row.id);
  },
};

function buildWhere(
  organizationId: string,
  userId: string,
  query: ListConversationsQuery,
): Prisma.ConversationWhereInput {
  const and: Prisma.ConversationWhereInput[] = [];

  if (query.status?.length) and.push({ status: { in: query.status } });
  if (query.priority?.length) and.push({ priority: { in: query.priority } });
  if (query.channel) and.push({ channel: query.channel });
  if (query.customerId) and.push({ customerId: query.customerId });

  if (query.assignee === "me") and.push({ assignedToUserId: userId });
  else if (query.assignee === "unassigned") and.push({ assignedToUserId: null });
  else if (query.assignee) and.push({ assignedToUserId: query.assignee });

  // Every term must match the subject or the customer's name/email/company.
  for (const raw of searchTokens(query.q)) {
    const term = escapeLike(raw);
    and.push({
      OR: [
        { subject: { contains: term, mode: "insensitive" } },
        { customer: { firstName: { contains: term, mode: "insensitive" } } },
        { customer: { lastName: { contains: term, mode: "insensitive" } } },
        { customer: { email: { contains: term, mode: "insensitive" } } },
        { customer: { company: { contains: term, mode: "insensitive" } } },
      ],
    });
  }

  return { organizationId, AND: and };
}
