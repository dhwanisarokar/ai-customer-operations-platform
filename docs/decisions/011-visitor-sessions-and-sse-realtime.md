# 011 - Visitor sessions, a public API boundary and SSE realtime

Status: accepted

## Context

Phase 7 puts a chat widget on customers' websites. Visitors are anonymous, the API is public, and agents
should see new messages without refreshing.

## Decision

- **Visitors are not users.** A `visitor_sessions` row (random bearer token, only its hash stored, sliding
  30 day expiry, revocable) carries the organization and, once known, a customer. There is no Clerk
  user, membership or role; a visitor can only call `/api/widget/*`, which is a separate, minimal API.
  Internal APIs are never exposed to the widget.
- **The server decides identity and tenancy.** The public key selects the organization, the token
  selects the session; clients cannot send `organizationId`, `customerId` or a sender (strict schemas).
  Customers are resolved by normalized email within the organization and are never edited by a visitor.
- **No parallel domain.** Web chat reuses `conversations`, `messages`, `conversation_events` and
  `customers` (`channel = WEB_CHAT`). Services take an `Actor` (`user` | `customer`) so the same
  persistence path writes agent and visitor messages; the audit trail records actor type `CUSTOMER`.
- **Realtime as hints over SSE**, published after commit, with Redis pub/sub between instances (and an
  in-process fallback). The database remains the source of truth; clients refetch.
- **No autonomous AI.** The widget never triggers a model reply. Handoff only marks the conversation for
  humans.

## Alternatives considered

- **WebSockets / a hosted realtime service:** more infrastructure and an extra authorization surface for
  one-way notifications. SSE is enough; it can be swapped behind `src/server/realtime`.
- **Pushing message content over realtime:** rejected; a leak or reordering bug would expose data. Hints
  plus an authorized refetch keep one authorization path.
- **A separate widget data model:** rejected; it would fork the inbox, automations and audit logic.
- **Visitor cookies instead of a bearer token:** third-party cookie restrictions break embedded iframes;
  a token in the iframe origin's storage is simpler and not readable by the host page.

## Consequences

- One more table pair (`widget_settings`, `visitor_sessions`) and additive columns; migrations are
  additive only.
- The origin allowlist is an embedding policy, not authentication. Abuse resistance rests on rate limits,
  caps and the narrow API.
- SSE needs a runtime that supports streaming responses; without it the widget polls.
