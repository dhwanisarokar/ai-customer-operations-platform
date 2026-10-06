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
