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

| Table           | Notes                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `organizations` | Tenant root. Unique index on `slug` (lookup by URL slug, uniqueness). |

## Workflow

```bash
npm run db:migrate   # dev: create + apply a migration after editing schema.prisma
npm run db:deploy    # CI/prod: apply committed migrations
```

The `vector` extension will be enabled by a migration (`CREATE EXTENSION vector`) when the knowledge
base is built.
