# Customer management (Customer 360)

```text
Organization
   └── Customer ──┬── CustomerTag ── Tag        (many-to-many, same organization)
                  ├── CustomerNote               (internal, authored by a member)
                  └── CustomerActivity           (timeline; one row per event)
```

Code map: `src/features/customers` (schemas, normalization, list-URL helpers, UI components),
`src/server/services/customer*.ts` (rules + transactions), `src/server/repositories/customer*.ts`,
`tags.ts` (org-scoped queries), `src/app/api/customers|tags` (thin routes),
`src/app/(app)/dashboard/customers` (pages).

## Data model

| Field                           | Notes                                                                                                 |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `organizationId`                | Required. Set from the authenticated context, never from input.                                       |
| `firstName`                     | Required. `lastName` optional (mononyms, companies).                                                  |
| `email`                         | Optional, stored lowercased/trimmed. Unique **per organization** (`organizationId, email`).           |
| `phone`                         | Optional, stored as optional `+` plus digits only (5-15 digits). See below.                           |
| `company`, `jobTitle`, `source` | Optional free text (source is a label such as "website", not an enum, so teams can define their own). |
| `externalId`                    | Optional id from another system. Unique per organization.                                             |
| `status`, `archivedAt`          | `ACTIVE`, `INACTIVE`, `ARCHIVED`. CHECK: archived exactly when `archivedAt` is set.                   |
| `metadata`                      | Optional JSON object for integrations.                                                                |
| `lastActivityAt`                | Denormalized newest-activity time, updated in the same transaction as each activity.                  |
| `createdAt`, `updatedAt`        | `updatedAt` changes on profile edits only (not on notes/tags).                                        |

Dropped from the suggested schema: `avatarUrl` (nothing produces avatars yet; add with file uploads).

**Email.** Normalized to lowercase so `USER@EXAMPLE.COM` and `user@example.com` are the same
customer. Blank means "no email" (NULL); many customers may have none. Archived customers keep
their email, so re-adding an archived customer's email returns 409: restore the existing record.

**Phone.** We do not guess country codes or parse locale rules. The input may contain spaces,
dashes, dots and parentheses; we store `+` (if typed) followed by digits: `+1 (555) 010-9999`
becomes `+15550109999`, and `020 7946 0958` becomes `02079460958`. 5-15 digits are accepted
(E.164 allows at most 15). Search matches on digits, so `(555) 0101` finds `+15550101`.
A real E.164 parser (libphonenumber) can replace this once a default country per organization exists.

**Archive, not delete.** `DELETE /api/customers/:id` sets `status=ARCHIVED` and `archivedAt`.
History, notes and tags stay. Archived customers are hidden from the default list, remain readable
by id, and are restored by PATCHing an active status. Archiving twice is a no-op (one timeline entry).

## Tags

Per-organization catalogue (`Tag`) plus the `CustomerTag` link. Names are unique per organization
**case-insensitively** (`normalizedName` is the lowercased, whitespace-collapsed name) and may repeat
across organizations. Assigning accepts a `tagId` or a `name` (find-or-create). Deleting a tag
detaches it everywhere (cascade) without touching customers or writing per-customer timeline entries.

## Activities (timeline)

`CustomerActivity { type, title, description, metadata, actorType, actorId, createdAt }`.
Types today: `CUSTOMER_CREATED`, `CUSTOMER_UPDATED` (metadata holds `{changes: {field: {from, to}}}`),
`CUSTOMER_ARCHIVED`, `TAG_ADDED`, `TAG_REMOVED`, `NOTE_ADDED`. `actorType` is `USER`, `SYSTEM` or
`AI`; `actorId` is deliberately not a foreign key (future actors are not users, and history should
outlive user deletion). New event types need an enum value, and optionally an icon in
`activity-timeline.tsx` (unknown types still render). Every activity is written in the **same
transaction** as the change it describes. A no-op PATCH writes nothing.

## Notes

Internal text (1-5000 chars) with `authorId` taken from the authenticated user (a client-supplied
author is rejected). The author link is nullable (`ON DELETE SET NULL`) so notes outlive their author.
Adding a note writes a `NOTE_ADDED` activity with a 140-character preview.

## Permissions

| Permission                                            | MEMBER | ADMIN | OWNER |
| ----------------------------------------------------- | :----: | :---: | :---: |
| `view_customers`                                      |   x    |   x   |   x   |
| `create_customers`, `update_customers`                |   x    |   x   |   x   |
| `add_customer_notes`, `tag_customers` (assign/create) |   x    |   x   |   x   |
| `archive_customers`                                   |        |   x   |   x   |
| `manage_tags` (rename/delete shared tags)             |        |   x   |   x   |

Rationale: members do day-to-day work; actions that hide a customer or change a vocabulary shared
by the whole organization need an admin. OWNER has everything ADMIN has.

## Tenant isolation (defence in depth)

1. **Context**: routes call `requireOrganizationContext()`; the organization comes from the verified
   membership, never from the request. Unknown body fields (including `organizationId`) are rejected
   with 400, and unknown query parameters are ignored.
2. **Repositories**: every function takes `organizationId` and filters or keys by it
   (`id_organizationId`). There is no lookup by id alone.
3. **404, not 403**: another organization's customer/tag is indistinguishable from a missing one.
4. **Database**: child tables reference `(id, organizationId)` with composite foreign keys, so a
   note, activity or tag link cannot point across organizations even if application code is wrong
   ([ADR 005](decisions/005-composite-foreign-keys-for-tenant-consistency.md)).

## Listing: `GET /api/customers`

- **Pagination**: offset-based, `page` (from 1) and `pageSize` (default 25, max 100); the response
  includes `total` and `totalPages`. Chosen over cursors because the UI shows page numbers and totals
  and per-organization volumes are moderate; ordering has a unique tie-breaker (`id`) so pages never
  overlap. Cursor pagination is the upgrade path for very large tenants.
- **Search** `q`: split on whitespace (max 5 tokens); every token must match at least one of first
  name, last name, email, company (case-insensitive substring) or phone (digits). `%`, `_` and `\`
  are escaped. Runs in PostgreSQL.
- **Filters** (combined with AND): `status` (comma list), `tagIds` (comma list; customer must have
  **all**), `company` and `source` (case-insensitive exact), `createdFrom`/`createdTo` (ISO datetime,
  inclusive), `includeArchived`. Default excludes archived; `status=ARCHIVED` shows them.
- **Sort**: `sort` = `createdAt` (default), `updatedAt`, `name` (first, then last name, missing last
  names last) or `lastActivityAt`; `order` = `asc|desc`.
- **Payload**: table columns plus the tag names of the rows on the page (one batched query). No
  notes, activities or metadata.

## Indexes (and why)

| Index                                                                   | Serves                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| `UNIQUE (organizationId, email)`, `UNIQUE (organizationId, externalId)` | Per-tenant uniqueness; email lookup for conflict messages.   |
| `UNIQUE (id, organizationId)` on customers/tags                         | Target of the composite foreign keys and `id + org` lookups. |
| `(organizationId, status, createdAt DESC)`                              | Default list (status filter) sorted by newest.               |
| `(organizationId, createdAt DESC)`, `(organizationId, updatedAt DESC)`  | Sorting and creation-date range filters across all statuses. |
| `(organizationId, lastActivityAt DESC)`                                 | "Recently active" sort without joining the timeline.         |
| `(organizationId, firstName, lastName)`                                 | Name sort.                                                   |
| `customer_tags (customerId, tagId)` PK, `(organizationId, tagId)`       | Tags of a customer; customers having a tag.                  |
| `customer_activities (organizationId, customerId, createdAt DESC)`      | Timeline pages, newest first.                                |
| `customer_notes (organizationId, customerId, createdAt DESC)`           | Notes pages, newest first.                                   |
| `tags UNIQUE (organizationId, normalizedName)`                          | Case-insensitive uniqueness and lookup by name.              |

Not indexed on purpose: substring search. `ILIKE '%term%'` cannot use a btree; it is bounded by the
`organizationId` index. If a tenant grows large, add `pg_trgm` GIN indexes on the searched columns
(or move to full-text search). These indexes were designed from the query patterns above and have
not been load-tested.

## Seed data (development only)

`npm run db:seed -- --org <slug> [--count 40]` adds clearly fake customers (`@seed.example.com`),
tags and timeline entries to an existing organization. It refuses to run when `NODE_ENV=production`.
The app never reads or generates demo data itself.

## Conversations on Customer 360

`GET /api/customers/:id` also returns the customer's latest conversations and a conversation count,
and the detail page shows them with a link to start a new one. Conversations reference the
customer through the foreign key (no copied data); see [conversations](conversations.md).

## Known limitations

- Timeline timestamps and day groups are rendered on the server in the server's timezone.
- The detail page shows the latest 20 activities and 10 notes (the API paginates both fully).
- No bulk import/export, no merge of duplicate customers, no editing/deleting of notes.
