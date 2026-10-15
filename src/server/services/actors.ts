/**
 * Who performs a conversation change. The two authentication boundaries stay separate: a `user` is
 * an authenticated member of the organization (Clerk), a `customer` is an anonymous website visitor
 * identified only by its visitor session. Domain logic that both can trigger (creating a
 * conversation, adding a message) is written once and takes an Actor; permission checks stay with the
 * callers (RBAC for users, session ownership for visitors).
 */
export type Actor =
  | { kind: "user"; userId: string }
  | { kind: "customer"; visitorSessionId: string }
  // An authenticated customer of the customer portal (Phase 8): identified by the customer record its
  // verified identity is linked to, never by anything the client sends.
  | { kind: "portal"; customerId: string }
  // A customer who emailed the organization's support address (Phase 9.2): the customer record the inbound
  // email was matched to or created for, decided by the server from the verified sender, never by the client.
  | { kind: "email"; customerId: string }
  // The customer-facing AI assistant (web chat). It is not a user and has no permissions: it can only
  // add its own reply, through the code path that decided to answer.
  | { kind: "ai" };

/** The audit-event actor columns for an Actor. */
export function actorEvent(actor: Actor) {
  if (actor.kind === "user") return { actorType: "USER", actorId: actor.userId } as const;
  if (actor.kind === "ai") return { actorType: "AI", actorId: null } as const;
  if (actor.kind === "portal" || actor.kind === "email") {
    return { actorType: "CUSTOMER", actorId: actor.customerId } as const;
  }
  return { actorType: "CUSTOMER", actorId: actor.visitorSessionId } as const;
}

/** The user id of a staff actor; null for a visitor (visitors are never users). */
export function actorUserId(actor: Actor): string | null {
  return actor.kind === "user" ? actor.userId : null;
}

/** An id that matches no user: lets read-state lookups run for a visitor without any user row. */
export const NO_USER_ID = "00000000-0000-0000-0000-000000000000";
