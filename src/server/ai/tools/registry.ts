import { z } from "zod";
import { canTransition } from "@/features/conversations/transitions";
import { CONVERSATION_STATUSES } from "@/features/conversations/schemas";
import { SETTABLE_STATUSES, updateCustomerSchema } from "@/features/customers/schemas";
import { fullName } from "@/features/customers/normalize";
import { conversationMessagesRepository } from "@/server/repositories/conversation-messages";
import { tagsRepository } from "@/server/repositories/tags";
import { requireConversationState, getConversation } from "@/server/services/conversations";
import { requireCustomer, updateCustomer } from "@/server/services/customers";
import { searchKnowledge } from "@/server/services/knowledge-retrieval";
import { updateConversation } from "@/server/services/conversations";
import type { ToolDeclaration } from "@/server/ai/types";
import {
  ToolError,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolPreview,
} from "./types";

/**
 * The tool registry: the ONLY actions the AI can request. Tool inputs are strict Zod schemas that
 * contain no organization, user or permission fields, so a model that invents them gets a
 * VALIDATION_ERROR. Tools call the existing services with the trusted caller context, so the
 * existing RBAC, tenant scoping and business rules (e.g. status transitions) apply unchanged.
 */

export type AnyTool = ToolDefinition<unknown, unknown>;

/** Erases the input type for storage in a registry while keeping each definition type-checked. */
export function defineTool<TInput, TResult>(tool: ToolDefinition<TInput, TResult>): AnyTool {
  return tool as unknown as AnyTool;
}

export type ToolRegistry = ReadonlyMap<string, AnyTool>;

export function createToolRegistry(tools: AnyTool[]): ToolRegistry {
  return new Map(tools.map((tool) => [tool.name, tool]));
}

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Open",
  PENDING: "Pending",
  RESOLVED: "Resolved",
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  ARCHIVED: "Archived",
};
const label = (value: string | null | undefined) =>
  value == null || value === "" ? null : (STATUS_LABEL[value] ?? value);

function resolveConversationId(ec: ToolExecutionContext, requested: string | undefined): string {
  const id = requested ?? ec.conversationId;
  if (!id) throw new ToolError("VALIDATION_ERROR", "A conversationId is required.");
  return id;
}

const MESSAGE_PREVIEW_CHARS = 500;
const KNOWLEDGE_CHARS = 1200;

// ---- read-only tools -------------------------------------------------------------------------

const getCustomerTool = defineTool({
  name: "getCustomer",
  description:
    "Retrieves the profile of the customer in the current conversation: name, email, phone, company, job title, account status and tags. Use it whenever the customer asks about their own details or account (for example their name, company, email, phone number, role or status). Pass the customerId from <context>.",
  inputSchema: z.object({ customerId: z.uuid() }).strict(),
  riskLevel: "LOW",
  requiredPermission: "view_customers",
  async execute({ ctx }, input: { customerId: string }) {
    const customer = await requireCustomer(ctx, input.customerId);
    const tags = await tagsRepository.listForCustomer(ctx.organization.id, customer.id);
    // Explicit shape: no metadata, external ids or internal bookkeeping.
    return {
      id: customer.id,
      name: fullName(customer),
      email: customer.email,
      phone: customer.phone,
      company: customer.company,
      jobTitle: customer.jobTitle,
      status: customer.status,
      tags: tags.map((tag) => tag.name),
    };
  },
});

const getConversationTool = defineTool({
  name: "getConversation",
  description:
    "Reads the current conversation: its status, priority, subject, assignee and the most recent customer-facing messages. Use it when the customer asks about the state of this conversation or ticket. conversationId is optional and defaults to the current conversation.",
  inputSchema: z.object({ conversationId: z.uuid().optional() }).strict(),
  riskLevel: "LOW",
  requiredPermission: "view_conversations",
  async execute(ec, input: { conversationId?: string }) {
    const id = resolveConversationId(ec, input.conversationId);
    const conversation = await getConversation(ec.ctx, id);
    // Internal notes are never given to the AI, whoever is asking.
    const history = await conversationMessagesRepository.page(ec.ctx.organization.id, id, {
      limit: 10,
      includeInternal: false,
    });
    return {
      id: conversation.id,
      subject: conversation.subject,
      status: conversation.status,
      priority: conversation.priority,
      customer: { id: conversation.customer.id, name: conversation.customer.name },
      assignee: conversation.assignee
        ? (conversation.assignee.name ?? conversation.assignee.email)
        : null,
      recentMessages: history.items.map((message) => ({
        from: message.senderType,
        text: message.body.slice(0, MESSAGE_PREVIEW_CHARS),
        at: message.createdAt.toISOString(),
      })),
    };
  },
});

const searchKnowledgeTool = defineTool({
  name: "searchKnowledge",
  description:
    "Search this organization's published knowledge base for a topic. Relevant knowledge for the latest message is already provided when the reply is drafted, so use this only to look up a different or more specific topic.",
  inputSchema: z.object({ query: z.string().trim().min(1).max(300) }).strict(),
  riskLevel: "LOW",
  requiredPermission: "view_knowledge",
  async execute({ ctx }, input: { query: string }) {
    // Reuses the single retrieval implementation: this organization, published content only.
    const chunks = await searchKnowledge({
      organizationId: ctx.organization.id,
      query: input.query,
      limit: 3,
    });
    return chunks.map((chunk) => ({
      documentTitle: chunk.documentTitle,
      content: chunk.content.slice(0, KNOWLEDGE_CHARS),
      similarity: Number(chunk.similarity.toFixed(3)),
    }));
  },
});

// ---- mutating tools (always need approval) ----------------------------------------------------

const customerChangesSchema = z
  .object({
    firstName: z.string().max(100),
    lastName: z.string().max(100),
    email: z.string().max(254),
    phone: z.string().max(40),
    company: z.string().max(150),
    jobTitle: z.string().max(150),
    status: z.enum(SETTABLE_STATUSES),
  })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one change" });

type UpdateCustomerToolInput = {
  customerId: string;
  changes: z.output<typeof customerChangesSchema>;
};

/** Normalizes and validates with the SAME schema the customer API uses. */
function parseCustomerChanges(changes: z.output<typeof customerChangesSchema>) {
  const parsed = updateCustomerSchema.safeParse(changes);
  if (!parsed.success) {
    throw new ToolError(
      "VALIDATION_ERROR",
      parsed.error.issues.map((issue) => issue.message).join("; ") || "Invalid changes.",
    );
  }
  return parsed.data;
}

const FIELD_LABELS: Record<string, string> = {
  firstName: "First name",
  lastName: "Last name",
  email: "Email",
  phone: "Phone",
  company: "Company",
  jobTitle: "Job title",
  status: "Status",
};

const updateCustomerTool = defineTool({
  name: "updateCustomer",
  description:
    "Propose a change to a customer's profile (first name, last name, email, phone, company, job title, status). A human must approve it before anything changes.",
  inputSchema: z.object({ customerId: z.uuid(), changes: customerChangesSchema }).strict(),
  riskLevel: "MEDIUM",
  requiredPermission: "update_customers",
  async execute({ ctx }, input: UpdateCustomerToolInput) {
    const parsed = parseCustomerChanges(input.changes);
    const updated = await updateCustomer(ctx, input.customerId, parsed);
    return { customerId: updated.id, changedFields: Object.keys(parsed) };
  },
  async preview({ ctx }, input: UpdateCustomerToolInput): Promise<ToolPreview> {
    const parsed = parseCustomerChanges(input.changes);
    const current = await requireCustomer(ctx, input.customerId);
    const lines = (Object.keys(parsed) as (keyof typeof parsed)[])
      .map((field) => {
        const from = (current as Record<string, unknown>)[field];
        const to = parsed[field];
        return {
          label: FIELD_LABELS[field] ?? field,
          from: label(from == null ? null : String(from)),
          to: label(to == null ? null : String(to)),
          changed: JSON.stringify(from ?? null) !== JSON.stringify(to ?? null),
        };
      })
      .filter((line) => line.changed)
      .map(({ label: l, from, to }) => ({ label: l, from, to }));
    if (lines.length === 0) throw new ToolError("VALIDATION_ERROR", "Nothing would change.");
    return { title: `Update customer ${fullName(current)}`, lines };
  },
});

type ChangeStatusInput = {
  conversationId?: string;
  status: (typeof CONVERSATION_STATUSES)[number];
};

const changeConversationStatusTool = defineTool({
  name: "changeConversationStatus",
  description:
    "Propose changing a conversation's status (OPEN, PENDING or RESOLVED). Defaults to the current conversation. A human must approve it before anything changes.",
  inputSchema: z
    .object({ conversationId: z.uuid().optional(), status: z.enum(CONVERSATION_STATUSES) })
    .strict(),
  riskLevel: "MEDIUM",
  requiredPermission: "update_conversations",
  async execute(ec, input: ChangeStatusInput) {
    const id = resolveConversationId(ec, input.conversationId);
    // The existing service owns the transition rules and the audit event.
    const updated = await updateConversation(ec.ctx, id, { status: input.status });
    return { conversationId: updated.id, status: updated.status };
  },
  async preview(ec, input: ChangeStatusInput): Promise<ToolPreview> {
    const id = resolveConversationId(ec, input.conversationId);
    const current = await requireConversationState(ec.ctx, id);
    if (current.status === input.status) {
      throw new ToolError(
        "VALIDATION_ERROR",
        `The conversation is already ${label(current.status)}.`,
      );
    }
    if (!canTransition(current.status, input.status)) {
      throw new ToolError(
        "VALIDATION_ERROR",
        `A conversation cannot move from ${label(current.status)} to ${label(input.status)}.`,
      );
    }
    return {
      title: "Change conversation status",
      lines: [
        { label: "Conversation", from: null, to: current.subject },
        { label: "Status", from: label(current.status), to: label(input.status) },
      ],
    };
  },
});

export const defaultToolRegistry: ToolRegistry = createToolRegistry([
  getCustomerTool,
  getConversationTool,
  searchKnowledgeTool,
  updateCustomerTool,
  changeConversationStatusTool,
]);

export type { ToolDeclaration };

export function toolDeclarations(registry: ToolRegistry = defaultToolRegistry): ToolDeclaration[] {
  return [...registry.values()].map((tool) => {
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return { name: tool.name, description: tool.description, parametersJsonSchema: schema };
  });
}

/** Resolves a model-requested tool name. Unknown names are an error, never a guess. */
export function resolveTool(name: string, registry: ToolRegistry = defaultToolRegistry): AnyTool {
  const tool = registry.get(name);
  if (!tool) throw new ToolError("UNKNOWN_TOOL", "That tool does not exist.");
  return tool;
}
