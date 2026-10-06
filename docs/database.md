# Database

PostgreSQL 17 (pgvector image locally) accessed through Prisma 7 with the `@prisma/adapter-pg` driver
adapter. Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations` — never edit a deployed
schema by hand.

## Conventions

- Table names are plural snake_case via `@@map`; primary keys are UUIDs.
- Every org-owned table has a non-null `organizationId` FK to `organizations` and composite indexes
  that lead with `organizationId`, since all tenant queries filter on it.
- Indexes are added for a concrete query and documented here with the reason.
- Multi-step writes use transactions.

## Current tables

| Table           | Notes                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `users`         | Local identity. `authProviderId` (Clerk id) and `email` are unique. No credentials stored.                   |
| `organizations` | Tenant root. Unique `slug`; CHECK constraints: non-blank `name`, `slug` format and length.                   |
| `memberships`   | `userId` + `organizationId` (both FK, `ON DELETE CASCADE`) + `role` enum. Unique `(userId, organizationId)`. |

`Role` is a PostgreSQL enum: `OWNER`, `ADMIN`, `MEMBER`.

### Indexing decisions

- `memberships (userId, organizationId)` UNIQUE: enforces one membership per pair, and its leading
  `userId` column serves "list this user's organizations" and the hot tenant-gate lookup
  ("is user U in organization O?") on every request.
- `memberships (organizationId, role)`: "list an organization's members" and role counts (e.g. owner
  checks). Leads with `organizationId` like all tenant queries will.
- `users.authProviderId` UNIQUE: lookup on every authenticated request. `users.email` UNIQUE:
  add-member-by-email lookup and one-account-per-email.
- `organizations.slug` UNIQUE: slug uniqueness and lookup by slug.

### Hand-written migration

`20261006113500_organization_check_constraints` adds CHECK constraints that Prisma's schema language
cannot express. All other migrations are Prisma-generated and unedited. Keep the constraints in sync
with `src/features/organizations/slug.ts`.

## Workflow

```bash
npm run db:migrate   # dev: create + apply a migration after editing schema.prisma
npm run db:deploy    # CI/prod: apply committed migrations
```

The `vector` extension will be enabled by a migration (`CREATE EXTENSION vector`) when the knowledge
base is built.
