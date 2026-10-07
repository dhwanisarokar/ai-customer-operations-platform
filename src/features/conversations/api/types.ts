import type { Serialized } from "@/lib/query/serialize";
import type { Page } from "@/server/http/pagination";
import type { ConversationEventRecord } from "@/server/repositories/conversation-events";
import type { ConversationDto } from "@/server/repositories/conversations";
import type { ApprovalDto } from "@/server/ai/tools/types";
import type { listMessages } from "@/server/services/conversation-messages";
import type { listMembers } from "@/server/services/memberships";

export type ConversationJson = Serialized<ConversationDto>;
export type ConversationListResponse = Serialized<Page<ConversationDto>>;
export type ConversationDetailResponse = { conversation: ConversationJson };
export type MessagesResponse = Serialized<Awaited<ReturnType<typeof listMessages>>>;
export type MessageJson = MessagesResponse["items"][number];
export type ConversationEventsResponse = Serialized<Page<ConversationEventRecord>>;
export type MembersResponse = { members: Serialized<Awaited<ReturnType<typeof listMembers>>> };

/** A change the AI asked for that waits for a human (see docs/ai-tools.md). */
export type ApprovalJson = Serialized<ApprovalDto>;
export type ApprovalsResponse = { approvals: ApprovalJson[] };
export type ApprovalActionResponse = { approval: ApprovalJson };

export type MessagesParams = { limit: number; includeInternal: boolean };
export type EventsParams = { page: number; pageSize: number };

export const DEFAULT_MESSAGES_LIMIT = 50;
export const MAX_MESSAGES_LIMIT = 200;
export const DEFAULT_EVENTS_PARAMS: EventsParams = { page: 1, pageSize: 100 };

/**
 * A suggested reply from POST /ai-draft. It is NOT a message and is never stored: a person reviews
 * (and may edit) it, then sends it through the normal send-message flow.
 */
export type AiDraftResponse = {
  draft: string;
  grounded: boolean;
  intent: string;
  sources: { documentId: string; documentTitle: string; chunkId: string; chunkIndex: number }[];
  /** Changes the AI requested; pending a human decision (nothing has been applied). */
  approvals: ApprovalJson[];
};

/** What the composer submits. `type` and `from` mirror the API contract. */
export type SendMessageInput = {
  body: string;
  type: "MESSAGE" | "INTERNAL_NOTE";
  from: "USER" | "CUSTOMER";
};
