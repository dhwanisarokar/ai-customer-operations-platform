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
