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

## Live Gemini smoke test (manual)

`npm run ai:tools-smoke` exercises real function calling (profile question -> `getCustomer`, change
requests -> `updateCustomer` / `changeConversationStatus`, general question) and the drafting prompt
with tool results. It needs `GEMINI_API_KEY`, makes ~15 requests, never touches the database and is
never part of `npm test`. The mocked adapter tests in `src/server/ai/gemini/provider.test.ts` pin the
exact `@google/genai` request/response structures (`functionCall`, `functionResponse`, thought
signatures, multiple calls) and are typed against the installed SDK.

## Who may ask for a change (Phase 5 follow-up)

`ai-tools.test.ts` ("who asked") proves with the real draft route that a CUSTOMER message (and one logged
via Log customer message) creates an `updateCustomer` approval, while an agent Reply, an internal note, an
AI message, an already-answered request and an unrelated later customer message do not, even when the
scripted model asks for the change anyway; Ask AI still returns a draft. `provenance.test.ts` covers the
trailing-customer-run and value checks. `npm run ai:tools-smoke` includes live scenarios for
agent-authored text and a genuine customer request.

Regression `2b`/`2c` in `ai-tools.test.ts` and the staff-last cases in `prompts.test.ts` / `agent.test.ts` cover the draft for a staff-authored action-like message (no mutation, no approval, no "cannot" / "a team member will handle it" / "done"), and that a genuine customer request keeps the normal flow.

## Automations (Phase 6)

- Unit: `src/server/automation/conditions.test.ts` (operators, validation, evaluation, sanitizing),
  `registries.test.ts` (trigger and action registries, definition validation) and
  `queue/memory.test.ts` (dedupe, bounded retries, backoff, unrecoverable errors).
- `tests/integration/automations.test.ts` (real PostgreSQL, in-process queue): the acceptance scenario,
  replay idempotency (+ the database unique key), disabled automations, every trigger, failed
  transactions emit nothing, no loops, cross-tenant isolation, failed/permanent/transient actions, retries
  with partial progress, racing workers, stale-lock takeover, creator role re-checked at run time,
  unreachable queue, the whole API (CRUD, validation, fake `organizationId`, RBAC, tenant 404s, dry run).
- `tests/integration/automation-bullmq.test.ts`: the real BullMQ driver (delivery, dedupe, retry with
  backoff, unrecoverable) and an end-to-end run. **Skipped unless** `TEST_REDIS_URL` points at a throwaway
  Redis database 15 (the test flushes it): `TEST_REDIS_URL=redis://127.0.0.1:6379/15 npm test`. The
  ordinary suite needs no Redis.
- `src/features/automations/components/automations-ui.test.tsx`: builder, validation problems, trigger
  changes, read-only mode, list toggle, history and run details.

## Web chat widget and realtime (Phase 7)

- `tests/integration/widget.test.ts` (real PostgreSQL, calls the route handlers): settings and RBAC,
  invalid/disabled keys, origin allowlist, session start/resume/expiry/revocation, token hash storage,
  conversation creation and idempotency (`clientMessageId`, concurrent retries), visitor-authored messages,
  rejected client-supplied sender/org/customer, size/length validation, cross-visitor and cross-organization
  404s, internal notes never visible, identity resolution (normalized email, no duplicates, no cross-org
  link, existing customers untouched), handoff and claim, automation trigger from a visitor message, rate
  limits (429 + `Retry-After`), realtime routing (Visitor A vs B, org A vs org B, internal notes) and SSE
  authentication.
- `src/server/widget/widget.unit.test.ts`: key/token generation and hashing, schemas, origin
  normalization, rate limiter, channel authorization.
- `src/features/widget/components/*.test.tsx`: widget states (loading, unavailable, welcome, create,
  sending/failed/retry with the same id, handoff, reconnecting, expired-session recovery), SSE parsing, and
  the settings form. `use-inbox-realtime.test.tsx`: stream + reconnect reconciliation.
- Not covered: a real browser (no Playwright/Cypress is configured), the iframe loader, a real
  multi-instance Redis pub/sub run.

## Public widget isolation and browser check (Phase 7 follow-up)

- `src/proxy.test.ts`: the middleware matcher skips `/widget/*` and `/api/widget/*` but still matches
  `/dashboard`, `/api/me`, `/api/conversations`, `/api/widget-settings`, `/api/realtime/inbox`...; widget code
  imports nothing from Clerk; only `(app)/layout.tsx` has `ClerkProvider`.
- `chat-widget.test.tsx` also checks that React StrictMode opens exactly one visitor session.
- `src/server/redis-ready.test.ts`: the first Redis command waits for the connection.
- Manual real-browser check (Chrome driven by a throwaway playwright-core outside the repo, against a
  scratch database and Redis): a standalone HTML file with only the snippet loads the iframe with no Clerk
  request, a visitor chats, an agent reply (another process, via Redis) arrives live, handoff, internal
  note stays hidden, reload restores history. The agent side used the real services, not the signed-in
  dashboard UI (no Clerk credentials were available).

## Customer-facing AI and widget UI polish (Phase 7 follow-up)

- `tests/integration/customer-ai.test.ts` (real PostgreSQL, fake AI provider): answer from published
  knowledge shown to the visitor, small talk / off-topic / injection without a model call, no knowledge ->
  fallback offering a person (no handoff), ungrounded and leaked answers replaced, explicit request / accepted offer / unrelated "yes" / AI text is not consent / button / silence after handoff / duplicate handoff processing, internal notes /
  metadata / customer record never in the prompt, no tools or mutations, provider failure (retry, then safe
  fallback) and malformed output, realtime listener failure, AI off by default, duplicates (retried
  message, same job twice, concurrent workers), newest-message rule, handoff / assignment / human reply
  silence the AI, late answer discarded after a takeover, realtime only after persistence, tenant isolation.
- `tests/integration/customer-ai-bullmq.test.ts`: the same flow through real BullMQ + Redis (skipped without
  `TEST_REDIS_URL`).
- `src/server/ai/agent/customer-agent.test.ts`: customer-mode prompt/schema, no profile, fallback, account
  data, no handoff field, leak, malformed output, provider failure; the draft mode stays unchanged.
- `src/features/widget`: view model, derived titles, AI states, composer geometry is checked in a browser.
- Browser check (Chrome via playwright-core outside the repo, real Gemini, scratch PostgreSQL + Redis, the
  worker running): see the final report of the phase for the checks and results.

- `src/server/ai/policy/handoff.test.ts`: explicit-request and acceptance phrases and non-phrases.

## Handling mode and single handoff action (Phase 7 follow-up)

- `tests/integration/handling-mode.test.ts` (real PostgreSQL): initial mode (AI / HUMAN / in-app), visitor
  handoff, AI fallback does not switch, assignment / claim / unassign, agent reply vs note, manual and no-op
  switches, AI refused when disabled, queued job after a switch, scheduling refused for HUMAN, late answer
  discarded after a switch during generation, the atomic claim (a row-lock test and a race loop), duplicate jobs,
  resolved / reopened (AI-mode and taken-over), RBAC (member 403, anonymous 401, admin/owner), strict body,
  cross-tenant 404, and Ask AI drafts unchanged in both modes.
- `src/features/conversations/components/handling-mode-control.test.tsx`: labels, one-click switch to human,
  confirmation before AI (cancel sends nothing), server refusal shown, read-only without permission, hidden for
  non-web-chat.
- `src/features/widget/components/handoff-action.test.tsx`: exactly one action for an AI fallback, replaced by a
  status after requesting, no duplicate after reload or a realtime update, nothing after takeover, email sharing
  independent.
