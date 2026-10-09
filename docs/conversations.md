# Conversations & inbox

```text
Organization
   ├── Customer ── 1..n ── Conversation ──┬── Message (MESSAGE | INTERNAL_NOTE)
   │                          │           ├── ConversationEvent  (audit trail)
   │                          │           └── ConversationReadState (one row per member)
   └── Member ── assigned to ─┘
```

Code map: `src/features/conversations` (schemas, transition rules, inbox URL params, event wording,
UI components), `src/server/services/conversation*.ts` (rules + transactions),
`src/server/repositories/conversation*.ts` (org-scoped queries), `src/app/api/conversations`
(thin routes), `src/app/(app)/dashboard/inbox` (pages).

## Domain model

| Model                   | Purpose                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Conversation`          | One thread with one customer. `subject`, `status`, `priority`, `channel`, optional `assignedToUserId`, `closedAt`, and denormalized last-message fields. |
| `Message`               | Ordered entries. `senderType` (CUSTOMER, USER, SYSTEM, AI_AGENT), `senderUserId` (USER only), `messageType` (MESSAGE, INTERNAL_NOTE), `body`.            |
| `ConversationEvent`     | Business audit trail: CONVERSATION_CREATED, SUBJECT_CHANGED, STATUS_CHANGED, PRIORITY_CHANGED, ASSIGNED, UNASSIGNED, MESSAGE_SENT, INTERNAL_NOTE_ADDED.  |
| `ConversationReadState` | `(conversationId, userId, lastReadAt)`: per-member read marker.                                                                                          |

Enums: status `OPEN | PENDING | RESOLVED`; priority `LOW | NORMAL | HIGH | URGENT`; channel
`IN_APP` (EMAIL, WHATSAPP, SMS, CHAT are additive enum migrations later).

Customer data is **not** copied into conversations: the list joins the customer's name/company
through the foreign key, so a renamed customer is renamed everywhere.

### Decisions that differ from the first sketch

- **No `source` field.** "Who started it" is already in the `CONVERSATION_CREATED` event actor, and
  `channel` is the only real axis today. Adding it later is cheap; an unused column is not.
- **No `lastReadAt` on the conversation, and no `isRead` on messages.** Read state is per member (see below).
- **`MessageType` has no `SYSTEM_EVENT`.** System-generated history (status/priority/assignment
  changes) lives in `ConversationEvent`, which is the auditable source of truth. Writing the same
  fact as a message row too would be a second place to keep consistent. The UI merges events into
  the timeline as system lines. A `SYSTEM_EVENT` value (or `SYSTEM` sender messages) can be added
  when a feature needs system text that customers can see.
- **No `READ` event.** Opening a conversation is not a business transition and would flood the
  audit log; read state has its own table.
- **No `manage_conversations` permission.** Nothing needs it yet (see Authorization).

## Lifecycle and rules

Status transitions (`src/features/conversations/transitions.ts`):

```text
OPEN ──▶ PENDING ──▶ RESOLVED ──▶ OPEN
 │          │            ▲
 │          └──▶ OPEN    │
 └───────────────────────┘
```

`OPEN -> {PENDING, RESOLVED}`, `PENDING -> {OPEN, RESOLVED}`, `RESOLVED -> {OPEN}`. Anything else is
`409`. Resolving sets `closedAt`; reopening clears it (also a database CHECK: closed exactly when
RESOLVED). Same-value updates are no-ops and write no event.

Message rules:

- Agent replies are rejected on a RESOLVED conversation (`409`: reopen first). Internal notes and
  logged customer messages are always allowed.
- A **customer** message on a PENDING or RESOLVED conversation reopens it to OPEN (a
  `STATUS_CHANGED` event with `reason: customer_message` is recorded).
- Only customer-facing messages update `lastMessageAt`, `lastMessagePreview` and
  `lastMessageSenderType`. Internal notes never touch them.
- Sender identity comes from the session. `senderUserId`, `senderType`, `organizationId` and
  `conversationId` in a request body are rejected (`400`). The body field `from: "CUSTOMER"` records
  a message the customer sent (relayed by phone, or an in-app channel that does not exist yet): the
  stored sender is CUSTOMER with no user, and the staff member is the audit-event actor.

Assignment: ADMIN and OWNER can assign any member and unassign anyone. A MEMBER can only claim an
unassigned conversation for themselves or release their own. The assignee must be a member of the
organization (service check **and** a composite foreign key to `memberships`). When a member is
removed from the organization, their conversations are unassigned (with `UNASSIGNED` events,
reason `member_removed`) in the same transaction (`removeMember`).

Creation: validates the customer belongs to the organization (404 otherwise) and is not archived
(409), then writes the conversation, `CONVERSATION_CREATED`, an optional first message and its event
in one transaction. Rows of one operation get strictly increasing timestamps so timelines never
depend on tie-breaking.

## Internal notes

Customer-facing history is `messageType = MESSAGE`. `GET .../messages` **excludes internal notes
unless `includeInternal=true`**, and the inbox preview/last-message counters ignore them. The
database refuses a customer-authored internal note (CHECK). The UI renders notes with a dashed,
labelled "Internal note / Only visible to your team" style, distinct from customer and agent bubbles.
Events never contain message text (only ids and types), and message bodies are never logged.

## Read / unread

One `ConversationReadState` row per (conversation, member), so every agent has their own unread
state and a colleague reading a conversation does not clear it for you. A conversation is **unread
for a member** when `lastCustomerMessageAt` is newer than their `lastReadAt` (or they have no row).
`lastCustomerMessageAt` is denormalized on the conversation so the inbox list computes unread with
one filtered relation load, not a per-row query. Writing a message or creating a conversation marks
it read for the author. `POST .../read` is called by the UI when a conversation is opened. Only
customer messages create unread state; colleagues' replies and notes do not (v1 simplification, and
a future "mentions"/"replied by others" signal would add rows, not columns). Read rows cascade with
the membership.

## Message pagination

Cursor pagination, newest page first but returned chronologically:
`GET .../messages?limit=50&before=<messageId>&includeInternal=true` returns the `limit` messages
older than the cursor plus `hasMore`, `nextCursor` and `total`. The cursor must be a message of the
same conversation (else `400`). Ordering is `(createdAt, id)` so identical timestamps are stable.
The detail page loads the latest 50 (growable to 200 via a "Load earlier" link) and the audit events
in the same time window.

## Inbox list performance

The list is one query for rows plus one `count`, with the customer, assignee and the caller's read
state loaded by Prisma as batched relation loads (constant number of round-trips regardless of page
size). The last-message preview is denormalized on the conversation, so no message table access.
`tests/integration/conversations-query.test.ts` asserts that listing 2 rows and 25 rows issues the
same number of PostgreSQL queries.

Filters (AND): `status`, `priority` (comma lists), `assignee` (`me`, `unassigned`, or a user id),
`channel`, `customerId`, and `q` (every term matches the subject or the customer's name, email or
company; LIKE wildcards escaped). Sort: `lastMessageAt` (default), `createdAt`, `updatedAt`,
`priority`. Pagination: `page` / `pageSize` (max 100) with totals.

## Authorization

| Permission                                                        | MEMBER | ADMIN | OWNER |
| ----------------------------------------------------------------- | :----: | :---: | :---: |
| `view_conversations`                                              |   x    |   x   |   x   |
| `create_conversations`                                            |   x    |   x   |   x   |
| `update_conversations` (status, priority, subject)                |   x    |   x   |   x   |
| `send_messages` (replies, notes, logged customer messages)        |   x    |   x   |   x   |
| `assign_conversations` (assign others, reassign, unassign others) |        |   x   |   x   |

Members can also claim/release their own assignment without `assign_conversations`. Every request
goes through `requireOrganizationContext()`; the organization comes from the verified membership,
and another organization's conversation, message, customer or member is a `404` indistinguishable
from a missing one. See [ADR 006](decisions/006-conversation-tenant-integrity.md).

## Indexes

| Index (all lead with `organizationId`)                                | Serves                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `(organizationId, status, lastMessageAt DESC)`                        | Open / Pending / Resolved views, newest activity first.       |
| `(organizationId, lastMessageAt DESC)`                                | "All" view and the default sort.                              |
| `(organizationId, assignedToUserId, status)`                          | "Assigned to me" and per-assignee views.                      |
| `(organizationId, priority, lastMessageAt DESC)`                      | High / Urgent views (first-class inbox filters).              |
| `(organizationId, customerId, lastMessageAt DESC)`                    | Customer 360 conversations and the per-customer inbox filter. |
| `UNIQUE (id, organizationId)`                                         | Target of composite foreign keys from child tables.           |
| `messages (organizationId, conversationId, createdAt, id)`            | Timeline pages and cursor pagination.                         |
| `conversation_events (organizationId, conversationId, createdAt, id)` | Event window next to loaded messages, audit paging.           |
| `conversation_read_states` PK `(conversationId, userId)`              | The per-row read-state lookup in the list.                    |

Not indexed: free-text search (substring `ILIKE` bounded by the org index; add `pg_trgm` if a tenant
grows large), and `subject`/`createdAt` sorts beyond the org prefix. Indexes follow the query
patterns above and have not been load-tested.

## AI-agent compatibility (implemented in Phase 4)

The design below held up: AI replies are ordinary `Message` rows with `senderType = AI_AGENT` and
provenance in `messages.metadata`, their events use actor type `AI`, and no change to
`conversations` was needed. See [ai-agent.md](ai-agent.md). The original reasoning:

Nothing here needs to change shape for an AI participant:

- `MessageSenderType.AI_AGENT` already exists; an AI reply is a `Message` with that sender and
  `senderUserId = NULL` (the CHECK allows it). `ActivityActorType.AI` is already usable in events.
- Tool calls and approvals would be new tables referencing `(conversationId, organizationId)` and
  optionally a `messageId`, with the same composite-FK tenant guard, so no change to `conversations`
  or `messages` is required. They are deliberately not created now.
- Unread/preview logic is already keyed on sender type, so AI replies behave like agent replies.
- The audit `ConversationEvent` table can carry AI actions (`actorType = AI`) from day one.

## Known limitations

- No real-time updates (page refresh / navigation); no email or other channels; no attachments or rich text.
- An in-app customer portal does not exist, so customer messages are logged by staff (`from: CUSTOMER`).
- Reopening on customer reply and unread are computed from customer messages only.
- No browser (Playwright) test: real Clerk sign-in cannot be automated without test credentials.
  The API is covered by integration tests against PostgreSQL, the page composition by server-render
  tests against real data, and the interactive components by React Testing Library tests.
