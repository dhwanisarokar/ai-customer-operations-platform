import { transaction } from "@/db/client";
import { createLogger } from "@/lib/logger";
import { conversationEventsRepository } from "@/server/repositories/conversation-events";
import { visitorConversationsRepository } from "@/server/repositories/visitor-conversations";
import { publishConversationUpdated } from "@/server/realtime/domain";

const log = createLogger("widget");

/**
 * The visitor asked for a person (the widget button, or their own words / acceptance in a message; the
 * AI never triggers it by itself). In one transaction: sets the handoff marker (once), switches the
 * conversation to HUMAN handling (so no further automatic AI replies), and records the audit events.
 * It changes nothing else (no assignment, no status): a person claims the conversation through the
 * normal assign flow, which clears the marker. Returns true when this call set the marker (false = it
 * was already set); repeating the request adds no second event.
 */
export async function markHumanRequested(params: {
  organizationId: string;
  conversationId: string;
  /** The requester: the web chat visitor session or the portal customer (never both). */
  requester: { visitorSessionId: string } | { customerId: string };
}): Promise<boolean> {
  const { organizationId, conversationId, requester } = params;
  const actorId =
    "visitorSessionId" in requester ? requester.visitorSessionId : requester.customerId;
  const now = new Date();

  const { marked, modeChanged } = await transaction(async (tx) => {
    const result = await visitorConversationsRepository.requestPerson(
      organizationId,
      requester,
      conversationId,
      now,
      tx,
    );
    if (result.modeChanged) {
      await conversationEventsRepository.record(
        organizationId,
        conversationId,
        {
          type: "HANDLING_MODE_CHANGED",
          metadata: { from: "AI", to: "HUMAN", reason: "visitor_requested" },
          actorType: "CUSTOMER",
          actorId,
          createdAt: now,
        },
        tx,
      );
    }
    if (result.marked) {
      await conversationEventsRepository.record(
        organizationId,
        conversationId,
        {
          type: "HUMAN_REQUESTED",
          metadata: {},
          actorType: "CUSTOMER",
          actorId,
          createdAt: now,
        },
        tx,
      );
    }
    return result;
  });

  if (marked || modeChanged) {
    log.info({ organizationId, conversationId, marked, modeChanged }, "human requested");
    await publishConversationUpdated(
      organizationId,
      conversationId,
      "visitorSessionId" in requester
        ? { visitorSessionId: requester.visitorSessionId }
        : { portalCustomerId: requester.customerId },
    );
  }
  return marked;
}
