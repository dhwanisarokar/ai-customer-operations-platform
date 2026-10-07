# Testing

- **Unit/integration:** Vitest (`npm test`). Tests live beside source as `*.test.ts(x)`; cross-cutting
  tests and setup in `tests/`. React Testing Library + jest-dom are configured for component tests.
- **E2E:** Playwright — to be added with the first user journey.

## Priorities

Authorization and tenant isolation, validation failures, AI agent execution, workflow execution, job
retries, webhook idempotency, subscription state changes. Coverage is a signal, not a target.

## Layers

- **Unit** (always run): permission matrix, slug and schema validation, API error mapping, env.
- **Integration** (`tests/integration`, need PostgreSQL): route handlers are invoked directly and run
  against a **real database** through the real services and repositories. Only two things are
  replaced: the Clerk session (`getIdentity`) and the active-organization cookie, via
  `tests/helpers/mocks.ts`. Tenant isolation, RBAC, ownership transfer (including a concurrent race)
  and DB constraints are covered here.

## Running integration tests

```bash
docker compose up -d
createdb ai_ops_test   # or any throwaway database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_ops_test npm run db:deploy
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_ops_test npm test
```

Without `TEST_DATABASE_URL` the integration suites are **skipped** (reported as skipped, never
faked). The tests `TRUNCATE` the users/organizations/memberships tables; never point them at a
database you care about. CI runs them against a Postgres service container.

## Not yet covered

Real Clerk sessions and the sign-in/sign-up UI (needs Clerk test credentials) and Playwright E2E.

## Customer suites (Phase 2)

All run against real PostgreSQL via the route handlers, services and repositories; only the Clerk
session and cookie are doubled (`tests/helpers/mocks.ts`, fixtures in `tests/helpers/tenants.ts`).

| File                                       | Covers                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/customers.test.ts`            | Create/read/update/archive, normalization, tenant-aware duplicates, validation 400s, transaction rollback, activities, RBAC, restore.                                |
| `integration/customers-isolation.test.ts`  | Cross-tenant read/update/archive/activities/notes/tags (404, no side effects), foreign tag assignment, organizationId tampering, forged active org, multi-org users. |
| `integration/customers-query.test.ts`      | Pagination (no overlap, ties), search (fields, phone digits, tokens, wildcards), filters, sorting, archived handling.                                                |
| `integration/customer-tags-notes.test.ts`  | Tag catalogue and assignment, duplicate handling, notes, timeline ordering, `lastActivityAt`/`updatedAt` semantics, Customer 360 shape.                              |
| `integration/customer-constraints.test.ts` | Unique indexes, composite FKs (cross-tenant inserts rejected by the database), CHECK constraints, cascades.                                                          |
| `src/features/customers/*.test.*`          | Normalization, Zod schemas, list URL helpers (unit); timeline and form behaviour (React Testing Library, jsdom).                                                     |

Not covered: the server-rendered customer pages (they need a Clerk session) and Playwright E2E.
