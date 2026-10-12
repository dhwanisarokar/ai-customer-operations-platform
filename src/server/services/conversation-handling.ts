import { transaction } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { aiProviderAvailable } from "@/server/ai/client";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { publishConversationUpdated } from "@/server/realtime/domain";
import { conversationEventsRepository } from "@/server/repositories/conversation-events";
import { conversationsRepository, type ConversationDto } from "@/server/repositories/conversations";
import { customerAiRepository } from "@/server/repositories/customer-ai";
import { widgetSettingsRepository } from "@/server/repositories/widget-settings";
import { customerAiEnabledFor } from "./customer-ai";
import { eventActor } from "./conversations";

const log = createLogger("conversation-handling");

export type HandlingMode = "AI" | "HUMAN";

/**
 * An agent switches who answers a web chat conversation: the customer-facing AI (AI) or only people
 * (HUMAN). Needs `change_handling_mode` (ADMIN/OWNER); the organization comes from the session, so
 * another organization's conversation is simply "not found".
 *
 * - HUMAN: always allowed. Automatic replies stop immediately: queued jobs see the mode before they
 *   run, and a reply being generated is discarded when it is stored (atomic claim in persistMessage).
 * - AI: only for a web chat conversation of an organization with customer AI enabled and a provider.
 *   It sends nothing by itself: the next visitor message may be answered. The visitor's pending request
 *   marker is cleared (the request is answered); the audit events stay.
 *
 * The change is one conditional UPDATE (`from` -> `to`), so concurrent identical requests record a single
 * event and the loser is a no-op; nothing is published unless something changed.
 */
export async function setHandlingMode(
  ctx: OrganizationContext,
  conversationId: string,
  mode: HandlingMode,
): Promise<ConversationDto> {
  ctx.require("change_handling_mode");
  const organizationId = ctx.organization.id;

  const changed = await transaction(async (tx) => {
    const conversation = await customerAiRepository.findConversation(
      organizationId,
      conversationId,
      tx,
    );
    // Only web chat conversations have a visitor to answer. Anything else (or another tenant) is
    // reported the same way for HUMAN, and as a conflict for AI.
    if (!conversation) {
      const exists = await conversationsRepository.findState(organizationId, conversationId, tx);
      if (!exists) throw new NotFoundError("Conversation not found");
      if (mode === "AI") {
        throw new ConflictError("Only web chat conversations can be answered by the AI");
      }
      return { changed: false as const, visitorSessionId: null };
    }

    if (mode === "AI") {
      const settings = await widgetSettingsRepository.findByOrganization(organizationId, tx);
      if (!customerAiEnabledFor(settings, conversation.channel) || !aiProviderAvailable()) {
        throw new ConflictError("Customer-facing AI is not enabled for this organization");
      }
    }

    const from: HandlingMode = mode === "AI" ? "HUMAN" : "AI";
    const result = await tx.conversation.updateMany({
      where: { id: conversationId, organizationId, handlingMode: from },
      data: {
        handlingMode: mode,
        updatedAt: new Date(),
        // Back to AI answers the visitor's request for a person; history stays in the events.
        ...(mode === "AI" ? { humanRequestedAt: null } : {}),
      },
    });
    if (result.count === 0) {
      return { changed: false as const, visitorSessionId: conversation.visitorSessionId };
    }
    await conversationEventsRepository.record(
      organizationId,
      conversationId,
      {
        type: "HANDLING_MODE_CHANGED",
        metadata: { from, to: mode, reason: "agent" },
        ...eventActor(ctx),
      },
      tx,
    );
    return { changed: true as const, visitorSessionId: conversation.visitorSessionId };
  });

  if (changed.changed) {
    log.info(
      { organizationId, conversationId, actorId: ctx.user.id, mode },
      "handling mode changed",
    );
    await conversationsRepository
      .audienceOf(organizationId, conversationId)
      .then((audience) => publishConversationUpdated(organizationId, conversationId, audience));
  }
  const updated = await conversationsRepository.findById(
    organizationId,
    conversationId,
    ctx.user.id,
  );
  if (!updated) throw new NotFoundError("Conversation not found");
  return updated;
}
