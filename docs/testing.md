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

## Conversation suites (Phase 3)

Same approach as the customer suites: route handlers, services, repositories and PostgreSQL run
for real; only the Clerk session and the active-organization cookie are doubled.
Fixtures: `tests/helpers/conversations.ts`.

| File                                           | Covers                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integration/conversations.test.ts`            | Create (with/without first message), validation 400s, archived/foreign customer, read, PATCH, every status transition and `closedAt`, assignment rules per role, Customer 360. |
| `integration/conversation-messages.test.ts`    | Sender identity, spoofed fields, internal-note separation and non-leakage, resolved/pending lifecycle rules, per-member unread, cursor pagination, events.                     |
| `integration/conversations-query.test.ts`      | Pagination, search, status/priority/assignee/customer/channel filters, sorting, unread in the list, and a **no-N+1 check** (same query count for 2 and 25 rows).               |
| `integration/conversations-isolation.test.ts`  | Org A vs org B for every endpoint: read, messages, internal notes, send, status, priority, assignment, create, cursors, tampering, forged active org.                          |
| `integration/conversation-constraints.test.ts` | Composite FKs (cross-tenant inserts rejected), assignee must be a member, CHECK constraints, cascades, member removal handling, index definitions.                             |
| `integration/inbox-ui.test.tsx`                | Server-renders the real inbox detail, list and Customer 360 section against real data (no Clerk session needed).                                                               |
| `src/features/conversations/*.test.*`          | Zod schemas, transition rules, inbox URL params, event wording (unit); composer, controls, timeline (React Testing Library).                                                   |

### Browser (Playwright) tests

Not configured. A realistic end-to-end flow (sign in, create a conversation, reply, add a note,
change status) needs a real Clerk session, which cannot be automated without Clerk test
credentials (Clerk "testing tokens" plus a dedicated test instance). Adding Playwright without that
would only test the sign-in page. This is deferred, and the flow is covered layer by layer above.

### Test database safety

`tests/helpers/db.ts` refuses to run against a database whose name does not contain "test", because
the helpers `TRUNCATE` tables. Never point `TEST_DATABASE_URL` at a development or hosted database.

## Knowledge base and AI suites (Phase 4)

**Gemini is never called by automated tests.** `tests/helpers/ai.ts` provides a deterministic fake
`AIProvider`: hash-based bag-of-words embeddings (texts sharing meaningful words are similar), a
scripted/default model that answers from the first retrieved source, call recording, injectable
failures (provider error, invalid embedding size, count mismatch, delays) and configurable token
usage. The vitest config sets `GEMINI_API_KEY` to empty, so a key in your shell cannot leak into a
test, and lowers `RAG_MIN_SIMILARITY` to suit the fake embeddings. Everything else (services,
repositories, Prisma, **real PostgreSQL with pgvector**) runs for real.

pgvector is required for the integration tests: the CI service container is `pgvector/pgvector`,
and locally use a PostgreSQL that has the extension (the migration runs `CREATE EXTENSION vector`).

| File                                        | Covers                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration/knowledge.test.ts`             | CRUD, validation, list/search/filter/sort/pagination, publish/unpublish/archive/delete, chunk + 768-dim embedding creation, stale-chunk invalidation on edit, failed embedding leaves consistent state, concurrent edit (409), RBAC, tenant isolation.                                                               |
| `integration/knowledge-search.test.ts`      | Similarity ordering and scores, threshold, limit, published-only, stale-version exclusion, cross-organization isolation, no embeddings exposed.                                                                                                                                                                      |
| `integration/knowledge-constraints.test.ts` | Composite FK (cross-tenant chunk rejected), vector dimension enforced by PostgreSQL, CHECK constraints, cascades.                                                                                                                                                                                                    |
| `integration/ai-draft.test.ts`              | Draft returned with sources and nothing stored (no message, counters or events), sending a draft creates one ordinary agent message, uncertainty without knowledge, context contents and bounds, internal notes excluded, tenant isolation, preconditions, failure modes, concurrency, prompt-injection regressions. |
| `integration/knowledge-ui.test.tsx`         | Server-renders the knowledge table and the compose box with an AI suggestion ("Based on: ...") from real data.                                                                                                                                                                                                       |
| `src/server/ai/**/*.test.ts`                | Provider (SDK mocked): generation, usage mapping, errors, timeouts, empty/blocked output, embedding batching/format/dimensions; config; embedding validation; prompts and sanitization; context bounds; the agent pipeline with injection cases.                                                                     |
| `src/features/knowledge/*.test.*`           | Chunking (determinism, overlap, limits), schemas, list params, form and action components.                                                                                                                                                                                                                           |

### Real Gemini smoke test (manual)

`npm run ai:smoke` makes exactly 3 real requests (embed 2 documents, embed 1 query, generate 1
structured reply) with the key from `.env`, prints scores/latency/usage and never the key. It is
not part of `npm test` or CI. During development it also uncovered the batching pitfall described
in [rag.md](rag.md).

## Server-state suites (Phase 4.5)

- `tests/helpers/query.tsx` — `createTestQueryClient` (no retries, no gc delay, isolated per test),
  `renderHookWithQuery`, `renderWithQuery`, and `mockApi(routes)` which stubs `fetch` per
  `"METHOD /path"` and records calls. Gemini is never called; AI endpoints are mocked at the HTTP edge.
- Hook tests (`src/features/*/hooks/*.test.tsx`) cover queries (keys, pagination/filters preserved),
  mutations, optimistic update + rollback + race handling, the outbox (pending/failed/retry/discard)
  and AI pending/success/failure.
- Component tests render real components against the stubbed API (`conversation-pane`, controls,
  composer, ask-ai). Integration SSR tests render the client views with `serialize`d real-DB data.

## Conversation policy suites (Phase 4.6)

- `src/server/ai/policy/classifier.test.ts` — normalization and intent classification (greetings in
  many spellings, support questions incl. greeting + question, out-of-scope, injection, precedence).
- `tests/integration/ai-conversation-policy.test.ts` — through the real route with the fake provider:
  small talk, off-topic and injection make **zero** embedding/generation calls; support questions still
  run RAG and cite the real source; unknown questions stay ungrounded; all results are drafts and nothing is stored.
- `conversation-timeline-ai.test.tsx` — no source line for small talk, disclaimer for out-of-scope.
- The model-level injection regression tests in `ai-draft.test.ts` use phrasings that pass the policy
  filter on purpose, so the layered model defenses stay covered.

## AI draft and human review (Phase 4.9)

- `ai-draft.test.ts` (integration): the endpoint returns `{ draft, grounded, intent, sources }`, stores
  nothing, leaves counters/events untouched, and sending the draft through `/messages` creates exactly
  one ordinary `USER` message.
- `conversation-pane.test.tsx`: suggestion pre-fills the single compose box with source/warning, no message in the history,
  edit and discard create nothing, asking again replaces the draft, Send to customer goes through the
  optimistic outbox (one sent message), AI failure leaves no draft.
- `ask-ai-button.test.tsx` and the hook tests cover pending, success and failure of the mutation.

## AI tools and approval (Phase 5)

- `src/server/ai/tools/registry.test.ts`: registry contents, risk/permission mapping, strict input
  schemas (no organization/user/permission fields, no arbitrary change fields), declarations.
- `tests/integration/ai-tools.test.ts` (real PostgreSQL, fake provider): read tools and their explicit
  shapes, cross-tenant isolation, fake `organizationId`, unknown tool and invalid arguments, RBAC with a
  custom registry, risk policy (mutations create pending approvals and change nothing), the approval
  lifecycle (approve, reject, expire, double execution, concurrent double click, failure, tenant
  isolation, database CHECKs), audit rows, the API routes, and the AI draft flow with scripted function
  calls (read tool result reaches the draft prompt, mutation pauses for approval, 5-call limit, prompt
  injection cannot execute or cross tenants).
- `src/server/ai/gemini/provider.test.ts`: function-calling adapter (declarations only, automatic
  function calling disabled, tool results as one user turn, safe errors).
- `ai-approval-cards.test.tsx` and `conversation-pane.test.tsx`: pending card, exact change text,
  approve (loading, single call, result), reject, expired (no buttons), server refusal, failed
  execution, dismiss, and the card appearing after Ask AI.
- `FakeAiProvider.toolScript` scripts what the model REQUESTS; the application's decision is what is
  under test. Real Gemini is never called.
