# Realtime (Phase 7)

Realtime is a **hint** channel. An event says "something changed in conversation X"; clients refetch
from the normal, authorized, database-backed API. Events carry no message text, names or internal data,
so a lost, duplicated or reordered event can never corrupt or leak anything. PostgreSQL stays the source
of truth.

## Transport: Server-Sent Events

One-way server → client is all we need (clients write through REST). SSE works over plain HTTP, reconnects
by itself and needs no extra infrastructure. `src/server/realtime/sse.ts` streams: `retry: 3000`, an
`event: ready` on every (re)connection, events with an id, and a 20 s heartbeat comment.

- Staff: `GET /api/realtime/inbox` (Clerk session, `view_conversations`). The browser's `EventSource`
  reconnects automatically.
- Visitors: `GET /api/widget/events` (bearer token). `EventSource` cannot send headers, so the widget uses
  a `fetch` stream with its own backoff (1 s … 15 s).

## Channels and authorization

| Channel               | Subscribers                | Receives                                                                                                    |
| --------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `org:{orgId}:inbox`   | Staff of that organization | Every conversation change (messages incl. internal notes as a hint, status, assignment, priority, handoff). |
| `visitor:{sessionId}` | That one visitor session   | Only customer-facing messages, status and assignment changes of **its** conversations.                      |

A subscriber never names a channel. The route derives it from the authenticated identity (Clerk
membership / visitor session) and checks `canAgentSubscribe` / `canVisitorSubscribe` as a second line of
defense. Internal notes never go to a visitor channel; even for the inbox the event is only a hint.

## Event types

`message.created`, `conversation.created`, `conversation.updated` (handoff, priority),
`conversation.assigned`, `conversation.status_changed`. Shape: `{ id, type, conversationId, messageId?, at }`.

## Publishing

`emitDomainEvent` (`src/server/events/bus.ts`) is called **after the transaction committed** and calls
`publishForDomainEvent` without awaiting it, so realtime never delays or fails a request. The same events
feed the automation engine. The publisher (`publisher.ts`):

- always fans out to subscribers in the same process;
- when `REDIS_URL` is set (and `REALTIME_DRIVER=redis`, the default) also publishes on the Redis topic
  `realtime:events`, so other instances deliver to their own subscribers; each instance ignores its own
  echo;
- is best effort: failures are logged (no payloads) and swallowed.

## Reconciliation

- Inbox: `useInboxRealtime` (mounted in the dashboard layout) invalidates the conversation queries on
  every event and again on every reconnect after the first `ready`.
- Widget: invalidates the list and the touched conversation; on reconnect refetches everything; while the
  stream is down it polls every 8 s and shows "Reconnecting…".

## Configuration

`REALTIME_DRIVER=redis|memory` (default `redis`; without `REDIS_URL` it behaves as `memory`). With
`memory` only subscribers on the same Node process receive events, which is correct for one instance and
for tests.

## Limitations

- No replay (`Last-Event-ID` is ignored): reconciliation is a refetch.
- Long-lived SSE connections count against serverless/function time limits; deploy on a runtime that
  allows streaming responses (Node server, container). The widget degrades to polling if the stream drops.
- No presence or typing indicators.
