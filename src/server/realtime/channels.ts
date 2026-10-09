import type { OrganizationContext } from "@/server/auth/context";

/**
 * Realtime channels. There are exactly two kinds, and they never overlap:
 *
 *   org:{organizationId}:inbox   staff of ONE organization (the agent inbox)
 *   visitor:{sessionId}          ONE web chat visitor session
 *
 * A subscriber never names a channel: the route derives it from the authenticated identity (the
 * Clerk membership for staff, the visitor session for a visitor). The authorize functions below are
 * the second line of defense and are what the tests pin down.
 */
export const inboxChannel = (organizationId: string) => `org:${organizationId}:inbox`;
export const visitorChannel = (visitorSessionId: string) => `visitor:${visitorSessionId}`;

/** May this staff member listen to this channel? Only their own organization's inbox. */
export function canAgentSubscribe(ctx: OrganizationContext, channel: string): boolean {
  return ctx.can("view_conversations") && channel === inboxChannel(ctx.organization.id);
}

/** May this visitor listen to this channel? Only their own session's channel. */
export function canVisitorSubscribe(session: { id: string }, channel: string): boolean {
  return channel === visitorChannel(session.id);
}
