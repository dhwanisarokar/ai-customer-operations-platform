import { createLogger } from "@/lib/logger";
import {
  buildRetrievalQuery,
  toConversationContext,
  toCustomerContext,
} from "@/server/ai/agent/context";
import { runSupportAgent } from "@/server/ai/agent/agent";
import { AGENT_LIMITS, aiToolsEnabled } from "@/server/ai/config";
import { runToolPass } from "@/server/ai/tools/loop";
import type { ApprovalDto } from "@/server/ai/tools/types";
import { applyConversationPolicy } from "@/server/ai/policy/responses";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { conversationMessagesRepository } from "@/server/repositories/conversation-messages";
import { customersRepository } from "@/server/repositories/customers";
import { requireConversationState } from "./conversations";

const log = createLogger("ai-draft");

/** A suggested reply for a human to review. It is NOT a message: nothing about it is stored. */
export type AiDraft = {
  /** The suggested text. The human may edit it and, only then, send it as a normal message. */
  draft: string;
  /** True only when the draft is answered from, and cites, retrieved knowledge. */
  grounded: boolean;
  /** True when the draft is based on the customer's own record rather than the knowledge base. */
  accountData: boolean;
  /** How the policy handled the customer's message (CONVERSATIONAL, SUPPORT, ...). */
  intent: string;
  /** Knowledge the draft is based on (validated against what was really retrieved). */
  sources: { documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }[];
  /**
   * Changes the AI asked for that now WAIT for a human to approve. Nothing has been applied;
   * approving (or rejecting) goes through the approvals API.
   */
  approvals: ApprovalDto[];
};

/**
 * Conversations with a draft currently being generated (this process only). It stops obvious double
 * clicks and duplicate requests. It is not distributed: multi-instance deployments need the
 * Redis-based locking and rate limiting planned for a later phase.
 */
const inFlight = new Set<string>();

/**
 * Generates a suggested reply for a human to review. Read-only: authorize -> load bounded
 * customer-facing context -> conversation policy -> (for support questions) retrieve + generate ->
 * return the draft. Nothing is written: no message, no counter, no event. The draft only becomes a
 * conversation message when a person sends it through the normal send-message flow.
 */
export async function generateAiDraft(
  ctx: OrganizationContext,
  conversationId: string,
): Promise<AiDraft> {
  ctx.require("send_messages");
  const organizationId = ctx.organization.id;
  const lockKey = `${organizationId}:${conversationId}`;

  const state = await requireConversationState(ctx, conversationId);
  if (state.status === "RESOLVED") {
    throw new ConflictError("This conversation is resolved. Reopen it before generating a reply.");
  }
  if (inFlight.has(lockKey)) {
    throw new ConflictError("An AI draft is already being generated for this conversation.");
  }
  inFlight.add(lockKey);

  try {
    // Customer (tenant-scoped lookup) and bounded, customer-facing history only: internal notes
    // are never sent to the model.
    const customer = await customersRepository.findById(organizationId, state.customerId);
    if (!customer) throw new NotFoundError("Customer not found");
    const history = await conversationMessagesRepository.page(organizationId, conversationId, {
      limit: AGENT_LIMITS.maxContextMessages,
      includeInternal: false,
    });
    const messages = toConversationContext(history.items);
    const retrievalQuery = buildRetrievalQuery(messages);
    if (!retrievalQuery) {
      throw new ConflictError("There is no customer message to answer yet.");
    }

    // Conversation policy first: small talk, off-topic requests and obvious injection attempts get
    // fixed text (no embedding, vector search or model call). Everything else goes through the
    // unchanged RAG pipeline. The decision is server-side and grants nothing.
    const latestCustomerText = messages.filter((m) => m.role === "customer").at(-1)!.text;
    const decision = applyConversationPolicy(latestCustomerText);

    if (decision.handled) {
      log.info(
        { organizationId, conversationId, actorId: ctx.user.id, intent: decision.intent },
        "ai draft created",
      );
      return {
        draft: decision.reply,
        grounded: false,
        accountData: false,
        intent: decision.intent,
        sources: [],
        approvals: [],
      };
    }

    // Tool pass: the model may request lookups (run now) or changes (become pending approvals).
    // Authorization and risk policy are deterministic application code; see src/server/ai/tools.
    const toolPass = aiToolsEnabled()
      ? await runToolPass({ ctx, conversationId }, { customerId: customer.id, messages })
      : null;

    const result = await runSupportAgent({
      organizationId,
      customer: toCustomerContext(customer),
      messages,
      retrievalQuery,
      toolFindings: toolPass?.findings ?? null,
    });

    // Ids and measurements only: never the prompt, the draft or the customer's words.
    log.info(
      {
        organizationId,
        conversationId,
        actorId: ctx.user.id,
        intent: decision.intent,
        model: result.model,
        grounded: result.grounded,
        sources: result.sources.length,
        retrieved: result.retrievedChunkIds.length,
        latencyMs: result.latencyMs,
        totalTokens: result.usage.totalTokens,
        validation: result.validation,
        toolCalls: toolPass?.calls.length ?? 0,
        approvals: toolPass?.approvals.length ?? 0,
      },
      "ai draft created",
    );
    return {
      draft: result.reply,
      grounded: result.grounded,
      accountData: result.accountData,
      intent: decision.intent,
      sources: result.sources.map((source) => ({
        documentId: source.documentId,
        documentTitle: source.documentTitle,
        chunkId: source.chunkId,
        chunkIndex: source.chunkIndex,
      })),
      approvals: toolPass?.approvals ?? [],
    };
  } finally {
    inFlight.delete(lockKey);
  }
}
