import { transaction } from "@/db/client";
import { previewOf } from "@/features/conversations/transitions";
import type { Prisma } from "@/generated/prisma/client";
import { createLogger } from "@/lib/logger";
import {
  buildRetrievalQuery,
  toConversationContext,
  toCustomerContext,
} from "@/server/ai/agent/context";
import { runSupportAgent } from "@/server/ai/agent/agent";
import { AGENT_LIMITS } from "@/server/ai/config";
import { applyConversationPolicy } from "@/server/ai/policy/responses";
import { POLICY_VERSION } from "@/server/ai/policy/types";
import type { AgentResult } from "@/server/ai/agent/types";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { conversationEventsRepository } from "@/server/repositories/conversation-events";
import { conversationMessagesRepository } from "@/server/repositories/conversation-messages";
import { conversationsRepository } from "@/server/repositories/conversations";
import { customersRepository } from "@/server/repositories/customers";
import { timestampSequence } from "./clock";
import { requireConversationState } from "./conversations";

const log = createLogger("ai-reply");

/**
 * Conversations with an AI reply currently being generated (this process only). It stops obvious
 * double clicks and duplicate requests from producing two replies. It is not distributed:
 * multi-instance deployments need the Redis-based locking and rate limiting planned for a later
 * phase.
 */
const inFlight = new Set<string>();

/**
 * Generates a grounded reply with the AI agent and stores it as an AI_AGENT message.
 *
 * Phase 4 scope: the AI only drafts a reply into the conversation. It has no tools and performs no
 * business actions. Order of operations:
 *   authorize -> load bounded context (database) -> retrieve + generate (external, nothing written)
 *   -> ONE transaction writing message, conversation counters and event.
 * If the model call fails nothing is stored. If the database write fails after a successful model
 * call the error propagates (generic 500) and no message exists.
 */
export async function generateAiReply(ctx: OrganizationContext, conversationId: string) {
  ctx.require("send_messages");
  const organizationId = ctx.organization.id;
  const lockKey = `${organizationId}:${conversationId}`;

  const state = await requireConversationState(ctx, conversationId);
  if (state.status === "RESOLVED") {
    throw new ConflictError("This conversation is resolved. Reopen it before generating a reply.");
  }
  if (inFlight.has(lockKey)) {
    throw new ConflictError("An AI reply is already being generated for this conversation.");
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

    // Conversation policy first: small talk, off-topic requests and obvious injection attempts are
    // answered with fixed text (no embedding, vector search or model call). Everything else goes
    // through the unchanged RAG pipeline. The decision is server-side and grants nothing.
    const latestCustomerText = messages.filter((m) => m.role === "customer").at(-1)!.text;
    const decision = applyConversationPolicy(latestCustomerText);
    const result: AgentResult & { intent: string } = decision.handled
      ? {
          intent: decision.intent,
          reply: decision.reply,
          grounded: false,
          sources: [],
          retrievedChunkIds: [],
          promptVersion: POLICY_VERSION,
          model: "none",
          provider: "policy",
          latencyMs: 0,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null },
          validation: "ok",
        }
      : {
          intent: decision.intent,
          ...(await runSupportAgent({
            organizationId,
            customer: toCustomerContext(customer),
            messages,
            retrievalQuery,
          })),
        };

    const metadata = {
      kind: "ai_reply",
      intent: result.intent,
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion,
      grounded: result.grounded,
      validation: result.validation,
      retrievedChunkIds: result.retrievedChunkIds,
      sources: result.sources,
      usage: result.usage,
      latencyMs: result.latencyMs,
      requestedByUserId: ctx.user.id,
    } satisfies Prisma.InputJsonObject;

    const message = await transaction(async (tx) => {
      // The conversation may have been resolved while the model was working.
      const latest = await requireConversationState(ctx, conversationId, tx);
      if (latest.status === "RESOLVED") {
        throw new ConflictError("This conversation was resolved while the reply was generated.");
      }

      const next = timestampSequence();
      const now = next();
      const created = await conversationMessagesRepository.create(
        organizationId,
        conversationId,
        {
          senderType: "AI_AGENT",
          senderUserId: null,
          messageType: "MESSAGE",
          body: result.reply,
          metadata,
          createdAt: now,
        },
        tx,
      );
      await conversationsRepository.update(
        organizationId,
        conversationId,
        {
          lastMessageAt: now,
          lastMessagePreview: previewOf(result.reply),
          lastMessageSenderType: "AI_AGENT",
        },
        tx,
      );
      await conversationEventsRepository.record(
        organizationId,
        conversationId,
        {
          type: "MESSAGE_SENT",
          metadata: {
            messageId: created.id,
            senderType: "AI_AGENT",
            requestedByUserId: ctx.user.id,
            grounded: result.grounded,
          },
          actorType: "AI",
          actorId: null,
          createdAt: next(),
        },
        tx,
      );
      await conversationsRepository.markRead(
        organizationId,
        conversationId,
        ctx.user.id,
        next(),
        tx,
      );
      return created;
    });

    // Ids and measurements only: never the prompt, the reply or the customer's words.
    log.info(
      {
        organizationId,
        conversationId,
        messageId: message.id,
        actorId: ctx.user.id,
        model: result.model,
        intent: result.intent,
        grounded: result.grounded,
        sources: result.sources.length,
        retrieved: result.retrievedChunkIds.length,
        latencyMs: result.latencyMs,
        totalTokens: result.usage.totalTokens,
        validation: result.validation,
      },
      "ai reply created",
    );
    return message;
  } finally {
    inFlight.delete(lockKey);
  }
}
