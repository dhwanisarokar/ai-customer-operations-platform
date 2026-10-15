# API

All endpoints are JSON. Authentication is the Clerk session cookie. Errors share one shape:

```json
{
  "error": {
    "code": "forbidden",
    "message": "...",
    "requestId": "uuid",
    "details": [{ "path": "name", "message": "..." }]
  }
}
```

`details` is present for `validation_error` only. Codes: `validation_error` (400), `unauthorized`
(401), `forbidden` (403), `not_found` (404), `conflict` (409), `internal_error` (500).

Organization-scoped routes return **404** both for nonexistent organizations and for organizations
the caller does not belong to. Roles: `OWNER`, `ADMIN`, `MEMBER` (see [authorization](authorization.md)).

## Public

### `GET /api/health`

`200 {"status":"ok","checks":{"database":"up"}}` or `503` with `"degraded"`.

## Current user

### `GET /api/me` (auth required)

`200 { "user": { "id", "email", "name" } }`. Errors: 401, 403 (account has no email), 409.

### `PUT /api/me/active-organization` (auth required)

Body `{ "organizationId": uuid }`. Sets the active-organization cookie after verifying membership.
`200 { "organization": {id,name,slug}, "role" }`. Errors: 400, 401, 404 (not a member).

## Organizations

### `GET /api/organizations` (auth required)

`200 { "organizations": [{ id, name, slug, createdAt, role }] }`: only the caller's memberships.

### `POST /api/organizations` (auth required)

Body `{ "name": string (1-100, trimmed), "slug"?: string (2-48, ^[a-z0-9]+(-[a-z0-9]+)*$) }`.
Slug is generated from the name when omitted (a random suffix resolves collisions). Creates the
organization and the caller's OWNER membership in one transaction and makes it active.
`201 { "organization": { id, name, slug, createdAt, role: "OWNER" } }`.
Errors: 400, 401, 409 (explicit slug taken).

### `GET /api/organizations/:organizationId` (member)

`200 { "organization": { id, name, slug }, "role" }`. Errors: 401, 404.

## Members

### `GET /api/organizations/:organizationId/members` (any member)

`200 { "members": [{ userId, email, name, role, joinedAt }] }`. Errors: 401, 404.

### `POST /api/organizations/:organizationId/members` (OWNER, ADMIN)

Body `{ "email": string, "role"?: "ADMIN" | "MEMBER" (default MEMBER) }`. The user must already have
an account. ADMINs may add MEMBER only. `201 { "member": {...} }`.
Errors: 400, 401, 403, 404 (no such organization or no account for that email), 409 (already a member).

### `PATCH /api/organizations/:organizationId/members/:userId` (OWNER, ADMIN)

Body `{ "role": "ADMIN" | "MEMBER" }`. Requires outranking the target; ADMINs cannot grant ADMIN.
`200 { "member": {...} }`. Errors: 400, 401, 403, 404.

### `DELETE /api/organizations/:organizationId/members/:userId` (OWNER, ADMIN; or self)

`204`. Members may remove themselves; the owner can never be removed. Errors: 401, 403, 404.

### `POST /api/organizations/:organizationId/ownership-transfer` (OWNER)

Body `{ "userId": uuid }` (an existing member). Atomically makes them OWNER and demotes the caller
to ADMIN. `200 { "ok": true }`. Errors: 400, 401, 403, 404, 409 (concurrent change).

## Customers

Customer and tag endpoints act in the caller's **active organization** (resolved server-side from
their membership; there is no organization id in the URL and any `organizationId` sent by a client is
rejected in bodies and ignored in query strings). A customer or tag belonging to another
organization returns **404**. Full behaviour: [customer management](customer-management.md).

Customer object: `{ id, externalId, firstName, lastName, email, phone, company, jobTitle, status,
source, metadata, lastActivityAt, createdAt, updatedAt, archivedAt }` (no `organizationId`).
Paginated responses: `{ items, page, pageSize, total, totalPages }`.

### `GET /api/customers` (any member)

Query: `page` (default 1), `pageSize` (1-100, default 25), `q`, `status` (comma list of
ACTIVE/INACTIVE/ARCHIVED), `tagIds` (comma list of uuids; all required), `company`, `source`,
`createdFrom`, `createdTo` (ISO datetimes), `includeArchived` (`true|false`), `sort`
(`createdAt|updatedAt|name|lastActivityAt`), `order` (`asc|desc`).
`200` page of `{ id, firstName, lastName, email, phone, company, jobTitle, status, source,
lastActivityAt, createdAt, updatedAt, tags: [{id, name}] }`. Archived customers are excluded unless
`status` names them or `includeArchived=true`. Errors: 400, 401, 404 (no organization).

### `POST /api/customers` (create_customers: any member)

Body (unknown fields rejected): `firstName` (required), `lastName`, `email`, `phone`, `company`,
`jobTitle`, `source`, `externalId`, `status` (`ACTIVE` default | `INACTIVE`), `metadata` (object).
Blank strings become null; email is lowercased; phone is normalized. Creates the customer and a
`CUSTOMER_CREATED` activity atomically. `201 { customer }`.
Errors: 400, 401, 403, 409 (email or external id already used in this organization).

### `GET /api/customers/:customerId` (any member): Customer 360

`200 { customer, tags: [{id,name,createdAt}], recentActivities: [activity] (latest 20), notes: [note]
(latest 10), counts: { activities, notes } }`. Works for archived customers. Errors: 401, 404.

### `PATCH /api/customers/:customerId` (update_customers: any member)

Partial body with the same fields as create (at least one; `id`, `organizationId`, `createdAt`,
`archivedAt`, `status: ARCHIVED` are rejected). `null`/blank clears optional fields. Only changed
fields are written and recorded in a `CUSTOMER_UPDATED` activity; a no-op returns the customer
unchanged. Setting `status` to ACTIVE/INACTIVE on an archived customer restores it.
`200 { customer }`. Errors: 400, 401, 403, 404, 409.

### `DELETE /api/customers/:customerId` (archive_customers: ADMIN, OWNER)

Soft delete: sets `status=ARCHIVED` and `archivedAt`, writes `CUSTOMER_ARCHIVED`. Idempotent.
`204`. Errors: 401, 403, 404.

### `GET /api/customers/:customerId/activities` (any member)

Query `page`, `pageSize`. Paginated, newest first:
`{ id, type, title, description, metadata, actorType, actorId, createdAt }`. Errors: 400, 401, 404.

### `GET|POST /api/customers/:customerId/notes`

`GET` (any member): paginated, newest first `{ id, content, createdAt, updatedAt, author: {id, name,
email} | null }`. `POST` (add_customer_notes: any member): body `{ content }` (1-5000 chars, no
other fields); author is the caller. Writes `NOTE_ADDED`. `201 { note }`. Errors: 400, 401, 404.

### `GET|POST /api/customers/:customerId/tags`, `DELETE .../tags/:tagId`

`GET` (any member): `{ tags }`. `POST` (tag_customers: any member): body `{ tagId }` **or**
`{ name }` (finds the organization's tag by case-insensitive name, creating it if needed); writes
`TAG_ADDED`; `201 { tag }`; `409` if already assigned; `404` for another organization's tag.
`DELETE` (tag_customers): `204`, writes `TAG_REMOVED`; `404` if the tag is not assigned.

## Tags

### `GET /api/tags` (any member)

`200 { tags: [{ id, name, createdAt, customerCount }] }` sorted by name.

### `POST /api/tags` (tag_customers: any member)

Body `{ name }` (1-40 chars, whitespace collapsed). `201 { tag }`. Errors: 400, 401, 403,
409 (a tag with this name, ignoring case, exists).

### `PATCH /api/tags/:tagId` (manage_tags: ADMIN, OWNER)

Body `{ name }`. `200 { tag }`. Errors: 400, 401, 403, 404, 409.

### `DELETE /api/tags/:tagId` (manage_tags: ADMIN, OWNER)

Removes the tag and detaches it from all customers. `204`. Errors: 401, 403, 404.

## Conversations

Like customers, conversation endpoints act in the caller's **active organization** (resolved
server-side; no organization id in URLs; `organizationId`, `senderUserId`, `senderType` and other
server-owned fields are rejected in bodies and ignored in query strings). Another organization's
conversation, message, customer or member returns **404**. Behaviour and rules:
[conversations](conversations.md).

Conversation object: `{ id, subject, status, priority, channel, customer: {id, name, email,
company, status}, assignee: {id, name, email} | null, lastMessageAt, lastMessagePreview,
lastMessageSenderType, unread, createdAt, updatedAt, closedAt }`. `unread` is per calling member.

### `GET /api/conversations` (view_conversations)

Query: `page`, `pageSize` (1-100, default 25), `q`, `status` and `priority` (comma lists),
`assignee` (`me` | `unassigned` | user id), `channel` (`IN_APP`), `customerId`, `sort`
(`lastMessageAt` default | `createdAt` | `updatedAt` | `priority`), `order`. `200` paginated
`{ items, page, pageSize, total, totalPages }`. Errors: 400, 401, 404 (no organization).

### `POST /api/conversations` (create_conversations: any member)

Body (strict): `customerId` (uuid), `subject` (1-200), `priority` (default NORMAL), `channel`
(default IN_APP), optional `initialMessage: { body, from: "CUSTOMER" (default) | "USER" }`.
`201 { conversation }`. Errors: 400, 401, 403, 404 (customer not in this organization),
409 (customer archived).

### `GET /api/conversations/:conversationId` (view_conversations)

`200 { conversation }`. Errors: 401, 404.

### `PATCH /api/conversations/:conversationId` (update_conversations: any member)

Body (strict, at least one): `subject`, `status`, `priority`. Status changes follow the transition
rules (`OPEN -> PENDING|RESOLVED`, `PENDING -> OPEN|RESOLVED`, `RESOLVED -> OPEN`); resolving sets
`closedAt`, reopening clears it. Each real change writes an event; unchanged values are no-ops.
`200 { conversation }`. Errors: 400, 401, 403, 404, 409 (invalid transition).

### `POST /api/conversations/:conversationId/assign` (members: self only; ADMIN/OWNER: anyone)

Body `{ userId }` (must be a member of this organization). `200 { conversation }`.
Errors: 400, 401, 403 (member assigning others or taking over), 404 (conversation or member).

### `POST /api/conversations/:conversationId/unassign`

No body. Members may release only their own assignment; ADMIN/OWNER anyone's. Idempotent.
`200 { conversation }`. Errors: 401, 403, 404.

### `GET /api/conversations/:conversationId/messages` (view_conversations)

Messages of an **email** conversation that were sent by email carry `emailDelivery` (`state`: queued, sending, accepted, retrying, failed, unknown; `retryAt`, `acceptedAt`, `failedAt`, `failure`; the internal attempt counter is not exposed). `accepted` means the mail provider accepted it, not that it was delivered; `unknown` is neither success nor failure. Other channels have no such field.

Query: `limit` (1-200, default 50), `before` (message id cursor, must belong to this conversation),
`includeInternal` (`true|false`, default `false`: internal notes are excluded unless asked for).
`200 { items: [message] (oldest first), hasMore, nextCursor, total }` where message is
`{ id, senderType, senderUserId, messageType, body, createdAt, sender: {id, name, email} | null }`.
Errors: 400 (bad limit/cursor), 401, 404.

### `POST /api/conversations/:conversationId/email-reply` (send_messages: any member)

Send a reply to the customer BY EMAIL (conversations on the `EMAIL` channel only). Body, strict: `{ body, clientMessageId }` (`clientMessageId` is a UUID the
client generates once per logical reply and reuses on retry). Recipient, sender, subject, threading headers and organization are derived on the server and
rejected if sent (400). Returns `{ message, delivery, duplicate }`: **201** for a new reply (stored atomically with its outbound send, queued, NOT sent from the
request), **200** with `duplicate: true` for a repeat (nothing new created or queued). 404 for a conversation outside the caller's organization; 409 when the
conversation is not an email conversation, the customer has no address or is archived, email is not set up/enabled/verified, the conversation is resolved, or the key
was already used for different content / by another user / by a non-email message. **429** (`rate_limited`, with `Retry-After`; a generic message that names no tenant, recipient or limit) when an outbound limit is reached: per organization (minute, day), per account (minute) or per recipient (hour); see [email-operations](email-operations.md#outbound-abuse-limits-and-provider-assessment-phase-96). See [email-outbound](email-outbound.md#inbox-integration-phase-93b).

### `POST /api/conversations/:conversationId/messages` (send_messages: any member)

Body (strict): `body` (1-10000), `type` (`MESSAGE` default | `INTERNAL_NOTE`), `from` (`USER`
default | `CUSTOMER`; `CUSTOMER` is only valid for `MESSAGE`). The sender is the authenticated user
(or the customer when `from: CUSTOMER`, recorded by the staff member). Customer messages reopen
PENDING/RESOLVED conversations. `201 { message }`. Errors: 400, 401, 403, 404,
409 (agent reply on a resolved conversation).

### `GET /api/conversations/:conversationId/events` (view_conversations)

Paginated audit trail, newest first: `{ id, type, metadata, actorType, actorId, createdAt }`.
Query `page`, `pageSize`. Errors: 400, 401, 404.

### `POST /api/conversations/:conversationId/read` (view_conversations)

Marks the conversation read for the calling member only. `204`. Errors: 401, 404.

### Customer 360 addition

`GET /api/customers/:customerId` now also returns `conversations` (latest 5, conversation objects,
only for members with `view_conversations`) and `counts.conversations`.

## Knowledge base

Acts in the caller's active organization (no organization id in URLs; `organizationId` and other
server-owned fields are rejected in bodies and ignored in query strings; another organization's
document is a `404`). Embeddings are never returned. Behaviour and rules:
[knowledge-base.md](knowledge-base.md).

Document list item: `{ id, title, description, status, contentVersion, publishedAt, createdAt,
updatedAt, createdBy: {id, name, email} | null, chunkCount }`. Detail adds `content` and `updatedBy`.

### `GET /api/knowledge` (view_knowledge: any member)

Query: `page`, `pageSize` (1-100), `q` (title, description or content), `status` (comma list of
DRAFT, PUBLISHED, ARCHIVED), `sort` (`updatedAt` | `createdAt` | `title`), `order`. `200` paginated
`{ items, page, pageSize, total, totalPages }`. Errors: 400, 401.

### `POST /api/knowledge` (edit_knowledge: any member)

Body (strict): `title` (1-200), `description` (optional, <= 500), `content` (1-100,000 chars).
Creates a DRAFT; no embedding happens. `201 { document }`. Errors: 400, 401, 403.

### `GET /api/knowledge/:documentId` (view_knowledge)

`200 { document }` including `content`. Errors: 401, 404.

### `PATCH /api/knowledge/:documentId` (edit_knowledge for drafts; publish_knowledge for published/archived)

Body (strict, at least one): `title`, `description`, `content`. For a PUBLISHED document a title or
content change is re-chunked and re-embedded first, then content and chunks are swapped in one
transaction (the old chunks are never used again). `200 { document }`.
Errors: 400, 401, 403, 404, 409 (edited concurrently), 502/504 (embedding failed: nothing changed).

### `POST /api/knowledge/:documentId/publish` (publish_knowledge: ADMIN, OWNER)

Chunks and embeds the document, then publishes it. Idempotent. `200 { document }`.
Errors: 401, 403, 404, 409 (archived; or concurrently edited), 502/504 (embedding failed: stays a draft).

### `POST /api/knowledge/:documentId/unpublish` (publish_knowledge)

Back to DRAFT (also restores an ARCHIVED document); embeddings are deleted. `200 { document }`.

### `POST /api/knowledge/:documentId/archive` (publish_knowledge)

Sets ARCHIVED and deletes embeddings. `200 { document }`.

### `DELETE /api/knowledge/:documentId` (publish_knowledge)

Permanently deletes the document and its chunks. `204`. Errors: 401, 403, 404.

## AI draft

### `POST /api/conversations/:conversationId/ai-draft` (send_messages: any member)

No parameters (empty body or `{}`; anything else is `400`). Retrieves this organization's published
knowledge and asks the AI agent for a suggested reply. **Read-only**: nothing is stored and nothing is
sent. `200 { draft, grounded, intent, sources: [{documentId, documentTitle, chunkId, chunkIndex}], approvals: [Approval] }`.
`approvals` lists changes the AI requested that now wait for a human (see below); nothing in them has
been applied. A person reviews/edits the draft and sends it with `POST .../messages` (an ordinary message from that
member). Details: [ai-agent.md](ai-agent.md).

Errors: 400, 401, 404, 409 (resolved; no customer message to answer; another draft in flight),
502 `ai_unavailable` / `ai_invalid_response` / `ai_embedding_failed`, 503 `ai_not_configured`,
504 `ai_timeout`. Provider details are never in the response.

## AI action approvals

An **Approval** is `{ id, conversationId, toolName, riskLevel, status, preview: { title, lines: [{label,
from, to}] }, requestedByUserId, createdAt, expiresAt, failureCode }`. Statuses: `PENDING`, `APPROVED`,
`REJECTED`, `EXPIRED`, `EXECUTED`, `FAILED`. Details: [ai-tools.md](ai-tools.md).

### `GET /api/conversations/:conversationId/ai-approvals` (view_conversations)

`200 { approvals }`: pending, unexpired approvals of the conversation (stale ones are marked
`EXPIRED`). Errors: 401, 404.

### `POST /api/ai-approvals/:approvalId/approve` (the tool's permission, e.g. update_customers)

No body. Re-checks authentication, membership, permission, tenant, status and expiry; claims the
approval atomically and executes the action as the approver. `200 { approval }` with status
`EXECUTED` or `FAILED` (not retried). Errors: 401, 403 (no permission), 404 (unknown or another
organization's approval), 409 `approval_expired` / already handled.

### `POST /api/ai-approvals/:approvalId/reject`

No body. Allowed for the requester or anyone allowed to run the tool. `200 { approval }` (`REJECTED`);
nothing is executed. Errors as above.

## Automations

Details and lifecycle: [automations.md](automations.md). All routes are organization-scoped; another
organization's id is `404`.

| Method and path                                    | Permission          | Notes                                                   |
| -------------------------------------------------- | ------------------- | ------------------------------------------------------- |
| `GET /api/automations`                             | view_automations    | `page`, `pageSize`                                      |
| `POST /api/automations`                            | create_automations  | `201 { automation }`; strict body (no `organizationId`) |
| `GET /api/automations/:id`                         | view_automations    |                                                         |
| `PATCH /api/automations/:id`                       | update_automations  | partial; the whole definition is re-validated           |
| `DELETE /api/automations/:id`                      | delete_automations  | `204`                                                   |
| `POST /api/automations/:id/enable` / `disable`     | update_automations  | `{ automation }`                                        |
| `GET /api/automations/:id/executions`              | view_automations    | paged runs, newest first                                |
| `GET /api/automations/:id/executions/:executionId` | view_automations    | event data, condition results, action results, error    |
| `POST /api/automations/:id/test`                   | execute_automations | dry run with `{ data: {...} }`; executes nothing        |

Create/update body: `{ name, description?, enabled?, trigger, conditions: [{ field, operator, value? }],
actions: [{ type, input }] }`. Validation errors: `400 { error: { code: "validation_error", details: {
problems: string[] } } }`.

## Web chat (Phase 7)

Public visitor endpoints (`/api/widget/*`, bearer visitor token, rate limited) are documented in
[widget.md](widget.md). Staff endpoints:

| Endpoint                   | Permission         | Notes                                                                             |
| -------------------------- | ------------------ | --------------------------------------------------------------------------------- |
| `GET /api/widget-settings` | manage_widget      | `{ settings }`; creates disabled settings with a public key on first use          |
| `PUT /api/widget-settings` | manage_widget      | `{ enabled, displayName, welcomeMessage, accentColor, allowedOrigins }` (strict)  |
| `GET /api/realtime/inbox`  | view_conversations | `text/event-stream` for the caller's organization; see [realtime.md](realtime.md) |

Conversations now include `channel` (`IN_APP` or `WEB_CHAT`) and `humanRequestedAt`; the list accepts
`channel=WEB_CHAT`.

## Handling mode (Phase 7 follow-up)

| Endpoint                               | Permission           | Notes                                                                                                                                                                                |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/conversations/:id/handling` | change_handling_mode | `{ mode: "AI" or "HUMAN" }` (strict). Returns `{ conversation }`. 409 when AI is requested for a non-web-chat conversation or customer AI is disabled; 404 for another organization. |

Conversations now include `handlingMode`.

## Customer portal (Phase 8)

Customer endpoints (`/api/portal/{org}/...`, Clerk session + verified customer link) and the staff endpoints
(`/api/portal-settings`, `/api/customers/:id/portal-invite`, `/api/customers/:id/portal-access`, permission
`manage_portal`) are documented in [portal.md](portal.md). Conversations now also have channel `PORTAL`.

## Email settings (Phase 9.1)

Permission `manage_email` (ADMIN, OWNER); the organization is always the caller's. Bodies are strict.

| Endpoint                          | Notes                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/email-settings`         | `{ settings }`: `available`, `platformDomain`, `enabled`, `status`, `statusDetail`, `localPart`, `supportAddress`, `fromName`, `suggestedLocalPart`. Never creates a row.       |
| `PUT /api/email-settings`         | `{ localPart, fromName }`. 400 invalid or reserved name or unsafe sender name; 409 platform email unavailable or address taken. A new address resets verification and disables. |
| `POST /api/email-settings/verify` | Asks the provider to confirm the address: `ACTIVE`, or `FAILED` with a short code. 404 with no address; 409 unavailable.                                                        |
| `PUT /api/email-settings/enabled` | `{ enabled }`. Enabling needs `ACTIVE` (409 otherwise).                                                                                                                         |

Conversations may now have channel `EMAIL`. See [email](email.md).

## Outbound email operations (Phase 9.4)

Both endpoints need `manage_email` (ADMIN, OWNER) and act on the caller's organization only; there is no platform-wide variant.

- `GET /api/email-outbound/attention?page=&pageSize=&category=`: sends needing attention (`queued_overdue`, `retry_overdue`, `lease_expired`, `unknown`, `failed`), oldest
  first, `pageSize` at most 50, plus a `summary` of counts per category. Items carry ids, category, coarse state, `since`, a coarse `failure`, a MASKED recipient and
  `canRecheck`; never bodies, subjects, full addresses, provider ids, raw errors or leases.
- `POST /api/email-outbound/:sendId/recheck` (no body): asks the mail provider about an `UNKNOWN` send and records its answer (`found` -> accepted, `no_record` -> not sent,
  `unavailable` -> still unknown, `inconclusive` -> the provider has no record but its lookup no longer remembers that far back, so still unknown). 404 for another organization's send, 409 when the send is not unknown, the provider cannot be asked, or the last attempt is too recent to be sure (at least 10 minutes; longer when the provider's settle window requires).
  It never resends and the caller cannot choose the outcome.

See [email-outbound](email-outbound.md#operational-safety-phase-94).

## Background health (Phase 9.2 readiness)

`GET /api/health/background`: health of the worker, not of the web tier. 200 `{status:"ok"}` or 503 `{status:"degraded"}` with
`checks.worker` (`ok|stale|never|not_required`), `checks.events` and `checks.outbound` (`ok|delayed|stuck`) and numeric `details` (including `unknownEmails`). For an external
uptime monitor; see [email-operations](email-operations.md#worker-health).

## Inbound email webhook (Phase 9.2)

`POST /api/email/inbound` is called by the email provider, not by browsers. It has no session: the provider adapter
authenticates the request (signature and freshness) and everything else is derived on the server. Responses:
`200 {status: processed | held | ignored | duplicate}` (final, do not retry), `400` malformed, `401` bad or stale signature,
`404` no provider or no platform domain configured, `413` body over 256 KiB (enforced while reading, also without Content-Length), `503` the message could not be fetched yet (retry), `500` unexpected (retry).
See [email](email.md#inbound-processing-92).
