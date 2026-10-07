# 006 - Conversation tenant integrity and per-member read state

(Stored under `docs/decisions/` with the other ADRs.)

## Problem

Conversations connect several tenant-owned things: a customer, messages, audit events, an assigned
member and per-member read markers. Each carries an `organizationId`. A bug (or a forged id) must not
be able to link rows across organizations, and "unread" must work for many agents at once.

## Options considered

Tenant integrity:

1. Application checks only.
2. Composite foreign keys on `(id, organizationId)`, extending the Phase 2 pattern (ADR 005), plus a
   composite key to `memberships(userId, organizationId)` for the assignee.
3. Row-level security.

Read state:

1. `isRead` on messages or a single `lastReadAt` on the conversation.
2. One row per (conversation, member) holding `lastReadAt`.
3. One row per (message, member).

## Decision

- Composite foreign keys for `conversations -> customers`, `messages/events/read states -> conversations`,
  and `conversations.assignee -> memberships(userId, organizationId)`, in addition to the application
  checks (404 for foreign ids). RLS remains a possible later layer.
- Read state as one `ConversationReadState` row per (conversation, member), and `lastCustomerMessageAt`
  denormalized on the conversation so unread is `lastCustomerMessageAt > lastReadAt`.
- The assignee foreign key uses `NO ACTION`, so removing a member requires unassigning first; the
  `removeMember` service does both in one transaction. Read states reference the same membership
  with `CASCADE`.

## Reason

- The database refuses cross-tenant links even if a service forgets a check, and it also guarantees
  that an assignee is a member of that organization (`tests/integration/conversation-constraints.test.ts`
  attempts each cross-tenant insert directly).
- A per-member row gives every agent an independent unread state with constant-time list queries and
  no write amplification per message (option 3 would write a row per message per agent).
- Cascading deletes still work for whole organizations: `NO ACTION` is checked at statement end, so
  deleting an organization removes conversations and memberships in the same statement.

## Tradeoffs

- Removing a member (or deleting a user once that exists) has a required clean-up step. It is
  centralized in one service and covered by a test, and the database fails loudly if it is forgotten.
- Unread only reflects customer messages; richer signals (mentions, colleague replies) would add
  rows, not columns.
- Extra unique indexes and wider foreign keys, and every future conversation-owned table must follow
  the same pattern.
