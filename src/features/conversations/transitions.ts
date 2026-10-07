import type { ConversationStatus } from "./schemas";

/**
 * Allowed status transitions. A resolved conversation can only be reopened; anything else must
 * go through OPEN first so the history reads naturally.
 */
const TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  OPEN: ["PENDING", "RESOLVED"],
  PENDING: ["OPEN", "RESOLVED"],
  RESOLVED: ["OPEN"],
};

export function canTransition(from: ConversationStatus, to: ConversationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Statuses a conversation can move to from `from` (for building UI controls). */
export function allowedTransitions(from: ConversationStatus): readonly ConversationStatus[] {
  return TRANSITIONS[from];
}

/** Short preview stored on the conversation for the inbox list. */
export const PREVIEW_LENGTH = 140;

export function previewOf(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH - 1)}…` : flat;
}
