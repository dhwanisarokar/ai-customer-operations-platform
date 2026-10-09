import { createLogger } from "@/lib/logger";
import { runSupportAgent } from "@/server/ai/agent/agent";
import { buildRetrievalQuery, toConversationContext } from "@/server/ai/agent/context";
import { CUSTOMER_FALLBACK_REPLY } from "@/server/ai/agent/prompts";
import { aiProviderAvailable } from "@/server/ai/client";
import { AGENT_LIMITS } from "@/server/ai/config";
import {
  HANDOFF_ACKNOWLEDGEMENT,
  HANDOFF_OFFER_SENTENCE,
  isAcceptance,
  isExplicitHumanRequest,
  mentionsPerson,
} from "@/server/ai/policy/handoff";
import { applyConversationPolicy } from "@/server/ai/policy/responses";
import { ensureInlineWorker, getAutomationQueue } from "@/server/automation/queue";
import type { CustomerAiJob, JobAttempt } from "@/server/automation/queue/types";
import { ConflictError } from "@/server/errors";
import { getRateLimiter } from "@/server/rate-limit";
import { conversationMessagesRepository } from "@/server/repositories/conversation-messages";
import { customerAiRepository } from "@/server/repositories/customer-ai";
import { widgetSettingsRepository } from "@/server/repositories/widget-settings";
import { markHumanRequested } from "@/server/widget/handoff";
import { persistMessage } from "./conversation-messages";

const log = createLogger("customer-ai");

/** Attempts per visitor message (the queue may allow more; the reply must not take minutes). */
export const CUSTOMER_AI_MAX_ATTEMPTS = 2;

/** Cost guards on top of the widget's own message rate limits. */
const AI_LIMITS = {
  perSession: { limit: 10, windowSeconds: 60 },
  perOrganization: { limit: 300, windowSeconds: 3600 },
} as const;

/** BullMQ job ids may not contain ":". One job per visitor message. */
export const customerAiJobId = (messageId: string) => `customer-ai-${messageId}`;
/** The AI reply to a visitor message is stored with this client id: the unique
 * (conversationId, clientMessageId) constraint makes "one reply per message" a database guarantee. */
export const aiReplyClientId = (messageId: string) => `ai-reply-${messageId}`;

/**
 * May the customer-facing AI answer this conversation right now? Only in AI handling mode and not
 * while it is resolved. The mode is explicit (set by the visitor's handoff, an assignment, an agent's
 * reply or the agent's switch); it is never inferred from other fields. This is a cheap early check:
 * the guarantee is the atomic claim made when the reply is stored (see `persistMessage`).
 */
export function aiMayAnswer(conversation: {
  handlingMode: "AI" | "HUMAN";
  status: "OPEN" | "PENDING" | "RESOLVED";
}): boolean {
  return conversation.handlingMode === "AI" && conversation.status !== "RESOLVED";
}

/**
 * Called after a visitor message was stored. Queues ONE job for that message (job id = message id) if
 * the organization enabled customer AI and a provider is configured. Never throws and never waits for
 * the model: the visitor's request returns immediately and the answer arrives through realtime.
 * Safe to call again for the same message (a visitor retry): the queue ignores a known job id, and the
 * worker skips a message that already has its reply.
 */
export async function scheduleCustomerAiReply(params: {
  organizationId: string;
  conversationId: string;
  messageId: string;
  visitorSessionId: string;
}): Promise<void> {
  const { organizationId, conversationId, messageId, visitorSessionId } = params;
  try {
    if (!aiProviderAvailable()) return;
    const settings = await widgetSettingsRepository.findByOrganization(organizationId);
    if (!settings?.enabled || !settings.aiRepliesEnabled) return;

    // Mode is enforced BEFORE queueing as well (the worker checks again, and again when storing).
    const conversation = await customerAiRepository.findConversation(
      organizationId,
      conversationId,
    );
    if (!conversation || !aiMayAnswer(conversation)) return;

    const limiter = getRateLimiter();
    const [bySession, byOrganization] = await Promise.all([
      limiter.hit(`customer-ai:s:${visitorSessionId}`, AI_LIMITS.perSession),
      limiter.hit(`customer-ai:o:${organizationId}`, AI_LIMITS.perOrganization),
    ]);
    if (!bySession.allowed || !byOrganization.allowed) {
      log.warn({ organizationId, conversationId }, "customer ai skipped: rate limited");
      return;
    }

    // Lazy: the job dispatcher imports this module.
    const { processQueueJob } = await import("@/server/jobs");
    await ensureInlineWorker(processQueueJob);
    await getAutomationQueue().enqueue({
      kind: "customer-ai",
      executionId: customerAiJobId(messageId),
      organizationId,
      conversationId,
      messageId,
    });
  } catch (error) {
    log.warn(
      { organizationId, conversationId, err: error instanceof Error ? error.name : "unknown" },
      "customer ai could not be queued",
    );
  }
}

type CustomerReply = {
  body: string;
  intent: string;
  grounded: boolean;
  handoffSuggested: boolean;
  provider: string;
  model: string;
  promptVersion: string;
  validation: string;
  sources: { documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }[];
};

/**
 * Builds the visitor-facing answer. The model input is only: customer-visible messages (never notes),
 * published knowledge of THIS organization, and no customer record. No tools are involved: the AI
 * cannot read or change anything beyond answering.
 */
async function generateReply(
  organizationId: string,
  conversationId: string,
): Promise<CustomerReply> {
  const history = await conversationMessagesRepository.page(organizationId, conversationId, {
    limit: AGENT_LIMITS.maxContextMessages,
    includeInternal: false,
  });
  const messages = toConversationContext(history.items);
  const retrievalQuery = buildRetrievalQuery(messages);
  const latestCustomerText = messages.filter((m) => m.role === "customer").at(-1)?.text;
  if (!retrievalQuery || !latestCustomerText) throw new ConflictError("No visitor message");

  // The same deterministic policy as the internal assistant: small talk, off-topic requests and
  // injection attempts get fixed text without retrieval or a model call.
  const decision = applyConversationPolicy(latestCustomerText);
  if (decision.handled) {
    return {
      body: decision.reply,
      intent: decision.intent,
      grounded: false,
      handoffSuggested: decision.intent === "PROMPT_INJECTION",
      provider: "policy",
      model: "policy",
      promptVersion: "CONVERSATION_POLICY_V1",
      validation: "ok",
      sources: [],
    };
  }

  const result = await runSupportAgent({
    organizationId,
    mode: "customer",
    // No customer record is sent in customer mode (a visitor's identity is unverified).
    customer: { name: "Visitor", company: null, status: "ACTIVE" },
    messages,
    retrievalQuery,
    toolFindings: null,
  });
  // An answer that is not grounded in published knowledge OFFERS a person (the visitor decides): this
  // flag makes the offer explicit in the text and lets a later "yes" be read as accepting it. It never
  // starts a handoff by itself.
  const handoffSuggested = !result.grounded;
  return {
    body:
      handoffSuggested && !mentionsPerson(result.reply)
        ? `${result.reply} ${HANDOFF_OFFER_SENTENCE}`
        : result.reply,
    intent: "SUPPORT",
    grounded: result.grounded,
    handoffSuggested,
    provider: result.provider,
    model: result.model,
    promptVersion: result.promptVersion,
    validation: result.validation,
    sources: result.sources.map((source) => ({
      documentId: source.documentId,
      documentTitle: source.documentTitle,
      chunkId: source.chunkId,
      chunkIndex: source.chunkIndex,
    })),
  };
}

const failureReply = (): CustomerReply => ({
  body: CUSTOMER_FALLBACK_REPLY,
  intent: "FALLBACK",
  grounded: false,
  handoffSuggested: true,
  provider: "none",
  model: "none",
  promptVersion: "none",
  validation: "provider_failure",
  sources: [],
});

/**
 * The visitor asked for a person (or accepted the offer): set the handoff marker (once, with its event)
 * and acknowledge with a fixed message. Both steps are idempotent, so a retried or duplicated job adds
 * neither a second event nor a second acknowledgement. After this the AI stays silent (the
 * conversation is in human handling).
 */
async function handOffToPerson(params: {
  organizationId: string;
  conversationId: string;
  visitorSessionId: string;
  clientMessageId: string;
}) {
  const { organizationId, conversationId, visitorSessionId, clientMessageId } = params;
  await markHumanRequested({ organizationId, visitorSessionId, conversationId });
  try {
    await persistMessage({
      organizationId,
      actor: { kind: "ai" },
      conversationId,
      input: { body: HANDOFF_ACKNOWLEDGEMENT, type: "MESSAGE", from: "USER" },
      clientMessageId,
      requireAiMode: false, // the conversation was just switched to HUMAN by this very handoff
      metadata: {
        customerFacing: true,
        provider: "policy",
        model: "policy",
        promptVersion: "none",
        intent: "HANDOFF",
        grounded: false,
        validation: "ok",
        handoffSuggested: false,
        sources: [],
      },
    });
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error; // resolved meanwhile: nothing to say
  }
  log.info({ organizationId, conversationId }, "customer ai handed the conversation to a person");
}

/**
 * The worker side. Idempotent and safe under retries, duplicate jobs, crashes and concurrent workers:
 *
 *  - skips unless customer AI is enabled, the conversation is a web chat one and the message is a
 *    visitor message of that conversation;
 *  - skips when this message already has its reply, when a person is handling the conversation, or
 *    when a newer visitor message exists (that job answers with the full context);
 *  - stores the reply with a deterministic client id, so two workers can at worst both call the model:
 *    the database accepts one reply (the loser is a no-op, nothing is published twice);
 *  - a failed attempt is retried; on the last attempt the visitor gets a safe fallback instead of
 *    silence. Internal errors, prompts and model output are never stored or shown.
 */
export async function processCustomerAiJob(job: CustomerAiJob, attempt: JobAttempt): Promise<void> {
  const { organizationId, conversationId, messageId } = job;
  const lastAttempt = attempt.attempt >= Math.min(attempt.maxAttempts, CUSTOMER_AI_MAX_ATTEMPTS);
  const skip = (reason: string) =>
    log.info({ organizationId, conversationId, messageId, reason }, "customer ai skipped");

  const settings = await widgetSettingsRepository.findByOrganization(organizationId);
  if (!settings?.enabled || !settings.aiRepliesEnabled) return skip("disabled");

  const conversation = await customerAiRepository.findConversation(organizationId, conversationId);
  if (!conversation?.visitorSessionId) return skip("not_web_chat");
  const message = await customerAiRepository.findCustomerMessage(
    organizationId,
    conversationId,
    messageId,
  );
  if (!message) return skip("no_such_message");

  const clientMessageId = aiReplyClientId(messageId);
  const existing = await conversationMessagesRepository.findByClientMessageId(
    organizationId,
    conversationId,
    clientMessageId,
  );
  if (existing) return skip("already_answered");
  if (!aiMayAnswer(conversation)) return skip("not_ai_mode");
  if (await customerAiRepository.hasNewerCustomerMessage(organizationId, conversationId, message)) {
    return skip("superseded");
  }

  // A handoff needs the VISITOR's words: an explicit request, or a plain "yes" to an offer the system
  // recorded. Never the model's output, and never a mere lack of knowledge.
  const asksForPerson =
    isExplicitHumanRequest(message.body) ||
    (isAcceptance(message.body) &&
      (await customerAiRepository.previousMessageOfferedPerson(
        organizationId,
        conversationId,
        message,
      )));
  if (asksForPerson) {
    await handOffToPerson({
      organizationId,
      conversationId,
      visitorSessionId: conversation.visitorSessionId,
      clientMessageId,
    });
    return;
  }

  let reply: CustomerReply;
  try {
    reply = await generateReply(organizationId, conversationId);
  } catch (error) {
    log.warn(
      {
        organizationId,
        conversationId,
        messageId,
        attempt: attempt.attempt,
        err: error instanceof Error ? error.name : "unknown",
      },
      "customer ai attempt failed",
    );
    if (!lastAttempt) throw error; // let the queue retry
    reply = failureReply();
  }

  // Last line of defense is inside persistMessage (atomic). This only avoids storing a doomed reply.
  const state = await customerAiRepository.findConversation(organizationId, conversationId);
  if (!state || !aiMayAnswer(state)) return skip("mode_changed_during_generation");

  try {
    const { duplicate } = await persistMessage({
      organizationId,
      actor: { kind: "ai" },
      conversationId,
      input: { body: reply.body, type: "MESSAGE", from: "USER" },
      clientMessageId,
      metadata: {
        customerFacing: true,
        provider: reply.provider,
        model: reply.model,
        promptVersion: reply.promptVersion,
        intent: reply.intent,
        grounded: reply.grounded,
        validation: reply.validation,
        handoffSuggested: reply.handoffSuggested,
        sources: reply.sources,
      },
    });
    if (duplicate) return skip("already_answered");
  } catch (error) {
    // A person took over, the mode was switched, or the conversation was resolved while the model was
    // working: the late answer is discarded.
    if (error instanceof ConflictError) return skip("mode_changed_during_generation");
    throw error;
  }
  log.info(
    {
      organizationId,
      conversationId,
      messageId,
      intent: reply.intent,
      grounded: reply.grounded,
      validation: reply.validation,
    },
    "customer ai replied",
  );
}
