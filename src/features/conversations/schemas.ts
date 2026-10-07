import { z } from "zod";
import { collapseWhitespace } from "@/features/customers/normalize";
import { booleanParam, csv, paginationSchema } from "@/lib/query-params";

export const CONVERSATION_STATUSES = ["OPEN", "PENDING", "RESOLVED"] as const;
export const CONVERSATION_PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;
export const CONVERSATION_CHANNELS = ["IN_APP"] as const;

export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];
export type ConversationPriority = (typeof CONVERSATION_PRIORITIES)[number];

export const MAX_MESSAGE_LENGTH = 10_000;
export const MAX_SUBJECT_LENGTH = 200;

const subjectSchema = z
  .string()
  .transform(collapseWhitespace)
  .pipe(
    z
      .string()
      .min(1, "Subject is required")
      .max(MAX_SUBJECT_LENGTH, `Subject must be at most ${MAX_SUBJECT_LENGTH} characters`),
  );

const bodySchema = z
  .string()
  .trim()
  .min(1, "Message cannot be empty")
  .max(MAX_MESSAGE_LENGTH, `Message is too long (max ${MAX_MESSAGE_LENGTH} characters)`);

// .strict() everywhere: organizationId, senderUserId, status fields and other server-owned values
// are rejected with 400 instead of being silently ignored.
export const createConversationSchema = z
  .object({
    customerId: z.uuid(),
    subject: subjectSchema,
    priority: z.enum(CONVERSATION_PRIORITIES).default("NORMAL"),
    channel: z.enum(CONVERSATION_CHANNELS).default("IN_APP"),
    /** Optional first message. `from` says who wrote it: the customer (default) or the agent. */
    initialMessage: z
      .object({ body: bodySchema, from: z.enum(["CUSTOMER", "USER"]).default("CUSTOMER") })
      .strict()
      .optional(),
  })
  .strict();
export type CreateConversationInput = z.output<typeof createConversationSchema>;

export const updateConversationSchema = z
  .object({
    subject: subjectSchema.optional(),
    status: z.enum(CONVERSATION_STATUSES).optional(),
    priority: z.enum(CONVERSATION_PRIORITIES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field" });
export type UpdateConversationInput = z.output<typeof updateConversationSchema>;

export const assignConversationSchema = z.object({ userId: z.uuid() }).strict();

/**
 * `type` MESSAGE is customer-facing, INTERNAL_NOTE is staff-only. `from` CUSTOMER records a
 * message the customer sent (e.g. relayed by phone); the sender of everything else is always the
 * authenticated user, never a client-supplied id.
 */
export const sendMessageSchema = z
  .object({
    body: bodySchema,
    type: z.enum(["MESSAGE", "INTERNAL_NOTE"]).default("MESSAGE"),
    from: z.enum(["USER", "CUSTOMER"]).default("USER"),
  })
  .strict()
  .refine((value) => !(value.type === "INTERNAL_NOTE" && value.from === "CUSTOMER"), {
    message: "Internal notes are written by staff",
    path: ["from"],
  });
export type SendMessageInput = z.output<typeof sendMessageSchema>;

export const CONVERSATION_SORT_FIELDS = [
  "lastMessageAt",
  "createdAt",
  "updatedAt",
  "priority",
] as const;

const assigneeFilter = z.union([z.enum(["me", "unassigned"]), z.uuid()]);

export const listConversationsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(CONVERSATION_STATUSES)).optional(),
  priority: csv(z.enum(CONVERSATION_PRIORITIES)).optional(),
  assignee: assigneeFilter.optional(),
  channel: z.enum(CONVERSATION_CHANNELS).optional(),
  customerId: z.uuid().optional(),
  sort: z.enum(CONVERSATION_SORT_FIELDS).default("lastMessageAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type ListConversationsQuery = z.output<typeof listConversationsQuerySchema>;

export const MAX_MESSAGES_PAGE = 200;

/** Cursor pagination for message history: pass `before` (a message id) to load older messages. */
export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_MESSAGES_PAGE).default(50),
  before: z.uuid().optional(),
  includeInternal: booleanParam.optional().default(false),
});
export type ListMessagesQuery = z.output<typeof listMessagesQuerySchema>;

export { paginationSchema };
