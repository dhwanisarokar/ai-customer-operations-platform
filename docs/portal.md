# Customer portal (Phase 8)

A signed-in area where an invited customer follows **their own** conversations, sends messages, searches the
organization's published help articles and edits their name and phone. It lives at `/portal/{organization slug}`.

## Three authorization contexts

| Context               | Authenticated by                           | Authorized by                                                      | Reaches                            |
| --------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------- |
| Staff                 | Clerk                                      | organization membership + role (RBAC)                              | `/dashboard`, `/api/*` (internal)  |
| Anonymous visitor     | widget public key -> visitor session token | session ownership                                                  | `/widget/*`, `/api/widget/*`       |
| **Customer (portal)** | **Clerk**                                  | **an explicit link row: identity -> customer of one organization** | `/portal/*`, `/api/portal/{org}/*` |

Clerk is reused as the identity provider (same instance, same `users` table through the existing
just-in-time provisioning); no second provider is introduced. Clerk only proves who the person is. Access to a
customer record comes from `customer_portal_accounts`, never from an email comparison.

## Tenant resolution

The portal URL carries the organization **slug** (`organizations.slug`, already unique and public). The slug is
only a _selector_: the server looks the organization up (`requirePortalOrganization`), and an unknown slug and an
organization that has not enabled its portal (`portal_settings.enabled`, off by default) are the same 404.
`organizationId` is never accepted from a client. Every portal request derives:

```
Clerk session -> app user -> customer_portal_accounts(organizationId, userId) -> customer (this organization, not archived)
```

An authenticated identity without a link gets `403 portal_not_linked` and no data. A conversation, article or
customer that belongs to someone else is `404`, indistinguishable from one that does not exist.

## Linking an identity to a customer (the only way in)

1. A staff member with `manage_portal` (ADMIN/OWNER) opens the customer and creates an **invitation**
   (`POST /api/customers/:id/portal-invite`). The customer needs an email and must not be archived or already
   linked. The response contains a one-time link `/portal/{slug}/join?token=pi_...`; only the SHA-256 of the
   token is stored; it expires after 7 days and older pending invitations are cancelled.
2. The customer signs in (Clerk) and opens the link. `POST /api/portal/{slug}/join` redeems it. Both factors are
   required:
   - the token (single use, scoped to this organization and customer), **and**
   - the identity's own **verified** email (fetched from Clerk on the server) equal to the customer's email.
     A matching email without an invitation grants nothing; a forwarded invitation used by a different or
     unverified email grants nothing (`403 invite_email_mismatch`).
3. In one transaction the invitation is consumed (conditional update, so also single use under concurrency) and
   the link row is inserted.

Integrity is enforced by the database: `UNIQUE (organizationId, userId)` (an identity maps to one customer per
organization), `UNIQUE (organizationId, customerId)` (a customer is claimed by one identity) and the composite
foreign key `(customerId, organizationId) -> customers(id, organizationId)` (no cross-organization links).
Duplicates and concurrent redemptions end in `409`/`404`, never in two accounts. Staff can revoke access
(`DELETE /api/customers/:id/portal-access`), which removes the link and cancels pending invitations.

Consequences worth stating: a customer who is also a staff member is two independent things (their staff
routes need membership; the portal needs a link); the same email in two organizations is two customers and
needs two invitations; changing the email on a customer record does not move any link.

## API (`/api/portal/{org}/...`, customer session)

| Endpoint                                                 | Notes                                                                                                     |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET me`                                                 | Works before linking: `{ organization, linked, customer? }` (401 signed out, 404 unknown/disabled portal) |
| `POST join`                                              | `{ token }`; links the signed-in identity (see above)                                                     |
| `GET summary`                                            | counts and the 5 most recently updated conversations                                                      |
| `GET/PATCH profile`                                      | read; PATCH only `firstName`, `lastName`, `phone` (strict: `email`, `company`, ids... are `400`)          |
| `GET conversations?page&pageSize` / `POST conversations` | list (page size <= 50) / `{ subject, body, clientMessageId }`                                             |
| `GET conversations/:id`                                  | the conversation and its customer-visible messages (404 unless owned)                                     |
| `POST conversations/:id/messages`                        | `{ body, clientMessageId }` (author is always the linked customer; idempotent)                            |
| `POST conversations/:id/handoff`                         | "Talk to a person" (same handoff as web chat)                                                             |
| `GET help?q&page&pageSize` / `GET help/:id`              | published articles of this organization only                                                              |
| `GET events`                                             | SSE hints for this customer's own channel                                                                 |

Staff: `GET/PUT /api/portal-settings`, `POST /api/customers/:id/portal-invite`,
`GET/DELETE /api/customers/:id/portal-access`, all `manage_portal`.

Bodies are capped (16 KB), strict, rate limited per customer (messages 30/min, new conversations 10/hour,
handoff 10/hour, reads 300/min, profile 20/hour, join 10/hour). A client cannot supply `organizationId`,
`customerId`, `senderType`, `from`, `type`, `status`, `priority` or `handlingMode`.

## Conversations reuse the existing domain

- Portal conversations are ordinary `conversations` (new `ConversationChannel.PORTAL`, customer = the linked
  customer). Messages go through `persistMessage` with a new `portal` actor (sender `CUSTOMER`; events carry
  actor type `CUSTOMER`, actor id = the customer id), so idempotency (`clientMessageId`), status rules (a
  customer message reopens a resolved conversation), `message.created` events (automations), realtime and
  the inbox work unchanged. Staff see them in the Inbox with a "Portal" badge.
- The customer sees only `PORTAL` conversations of their own record. Staff-created and web chat conversations
  of the same customer are **not** shown (their subjects and history may be internal, and web chat identity
  resolution is unverified).
- The customer projection reuses the visitor DTO: `from` is `visitor` (the customer), `ai` or `team`, with
  the staff display name only. Internal notes, AI provenance (model, sources, prompts), assignees, tool and
  approval data are never selected.
- **AI and handling mode:** portal conversations are eligible for the customer-facing AI exactly like web chat
  (see [customer-ai](customer-ai.md)): the organization's AI switch decides the initial mode, the portal only
  _queues_ the job after storing the message (never waits for Gemini), and the worker, the handling mode, the
  resolved check and the atomic claim decide. Customers cannot change the mode, assign, prioritize or resolve.
- Realtime: a new channel `portal:{organizationId}:{customerId}` on the existing SSE hub; the route derives it
  from the verified link; internal notes are never published to it.

## Screens

Portal home (summary, recent conversations, start a conversation, help link), My conversations (paginated),
Conversation detail (history, status, one handoff control, composer, thinking state), New conversation, Help
center (search and browse, article page rendered as plain text), Profile (name and phone; email is read-only),
Join (accept an invitation), and a clear "not linked yet" explanation. Every view has loading, empty, error
and retry states. The layout is separate from the staff navigation.

## Limitations

- Access exists only through staff invitations (no self-service sign-up to a customer record), and the
  invitation link is shown to staff once; delivering it (email) is manual.
- A customer's email cannot be changed from the portal; changing it is a staff action (revoke + invite).
- Portal conversations do not include web chat or staff-created history; attachments, notifications and
  ratings are not implemented.
- The portal relies on Clerk sessions; a revoked link takes effect on the next request (no session kill).
- Rate limiting is per customer; Redis is used when `REDIS_URL` is set, otherwise per process.
