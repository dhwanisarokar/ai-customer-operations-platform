# AI Customer Operations Platform

A multi-tenant SaaS for support and customer-operations teams: a shared inbox, a 360-degree customer record, an AI assistant that
**drafts** replies for a person to approve, workflow automation, an embeddable web chat, a customer portal, and an email channel
foundation. It is a modular monolith (one Next.js application plus one background worker) on PostgreSQL.

> Status: feature-complete through Phase 9 (the email foundation). **Email is deliberately limited to an in-memory test provider:** no real
> email provider is integrated, so nothing can be sent to a real customer. See [Known limitations](#known-limitations).

## What it does

- **Organizations and access control.** Application-owned organizations and memberships (roles `OWNER`, `ADMIN`, `MEMBER`) on Clerk
  authentication; every query is scoped to the caller's organization, enforced again by composite foreign keys in PostgreSQL ([ADR 003](docs/decisions/003-tenant-isolation.md),
  [authorization](docs/authorization.md)).
- **Customer 360.** Customers, tags, notes and an activity timeline ([customer management](docs/customer-management.md)).
- **Shared inbox.** Conversations across channels (in-app, web chat, customer portal, email), assignment, status and priority, internal notes, and realtime updates over server-sent events ([conversations](docs/conversations.md), [realtime](docs/realtime.md)).
- **Knowledge base, RAG and an AI support agent.** Articles are embedded with Gemini into PostgreSQL/pgvector; the agent drafts grounded replies and can propose actions through tools. **A person approves** every
  customer-visible reply and every state-changing tool call ([knowledge base](docs/knowledge-base.md), [RAG](docs/rag.md), [AI agent](docs/ai-agent.md), [tools and approval](docs/ai-tools.md)).
- **Customer-facing AI (opt-in, read-only).** An organization can let the web chat answer automatically from its knowledge base until a person takes over ([customer AI](docs/customer-ai.md)).
- **Workflow automation.** A deterministic, event-driven engine with a BullMQ worker, retries and execution history ([automations](docs/automations.md)).
- **Web chat widget.** An embeddable launcher and iframe with anonymous visitor sessions, handoff to a person, and realtime messages ([widget](docs/widget.md)).
- **Customer portal.** Invited customers sign in, follow their own conversations, search help articles and edit their name and phone ([portal](docs/portal.md)).
- **Email channel foundation.** A hardened inbound pipeline (sender authentication, replay protection, quotas, held-mail lifecycle), a durable outbound outbox with retries, ambiguous-outcome safety, abuse limits and
  operational tooling, behind a provider interface. Only the fake provider exists ([email](docs/email.md), [outbound](docs/email-outbound.md), [provider readiness](docs/email-provider-readiness.md)).
- **Reliability and operations.** Durable domain events (outbox), structured metrics, separate web and worker health endpoints, security headers and a CSP, and a CI pipeline that applies the migrations to a fresh database ([deployment](docs/deployment.md)).

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 + shadcn/ui · Clerk · PostgreSQL + Prisma 7 + pgvector · Redis + BullMQ · Zod · Pino · Gemini (`@google/genai`) · TanStack Query · Vitest + React Testing Library.

## Architecture in one picture

```
Browser ──▶ Web (Next.js: UI, API routes, SSE, widget page) ──▶ PostgreSQL (+pgvector)   the source of truth
               │                                                    ▲
               └──── Redis (BullMQ queue, realtime fan-out) ◀──▶ Worker (jobs + maintenance loop)
                        Clerk (authentication)        Gemini (AI)
```

Two processes share the database and Redis: the **web** process and the **background worker**. Queue jobs are hints; PostgreSQL holds the state, so a lost job is re-created and a repeated one is harmless
([architecture](docs/architecture.md), [decisions](docs/decisions)).

## Getting started (local development)

Requirements: Node.js >= 22, Docker (for local PostgreSQL with pgvector and Redis).

```bash
npm install
cp .env.example .env        # add your Clerk keys and GEMINI_API_KEY (names are documented inside)
docker compose up -d        # PostgreSQL (pgvector) + Redis
npm run db:deploy           # apply migrations
npm run dev                 # web at http://localhost:3000, health at /api/health
npm run worker              # in a second terminal: queue consumer + maintenance (needs Redis)
```

The web app runs without the worker, but automations, customer-facing AI replies and the background-health endpoint need it. Without `GEMINI_API_KEY` the AI features answer 503.

## Scripts

| Script                                             | Purpose                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `npm run dev` / `build` / `start`                  | Next.js                                                                                       |
| `npm run worker`                                   | Background worker (BullMQ consumer + maintenance loop)                                        |
| `npm run typecheck` / `lint` / `format:check`      | TypeScript, ESLint, Prettier                                                                  |
| `npm test`                                         | Vitest (unit tests; integration suites run when `TEST_DATABASE_URL` is set)                   |
| `npm run check`                                    | typecheck + lint + format check + tests                                                       |
| `npm run db:deploy` / `db:migrate` / `db:generate` | Apply migrations (CI, production) / create one (development) / generate client                |
| `npm run db:seed -- --org <slug>`                  | Development only: fake customers for an existing organization                                 |
| `npm run ai:smoke`                                 | Real Gemini check (3 requests); prints scores, never the key                                  |
| `bash scripts/smoke-production.sh`                 | Smoke test of a built app: fail-fast configuration, security headers, health                  |
| `npm run email:resolve-unknown`                    | Operator tool for outbound email in an unknown state ([operations](docs/email-operations.md)) |

## Testing

```bash
npm test                                            # unit and component tests
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/ai_ops_test npm test       # + PostgreSQL integration suites
TEST_REDIS_URL=redis://localhost:6379/15 TEST_DATABASE_URL=... npm test                     # + real BullMQ tests
```

The test database is **truncated**: it must be a throwaway whose name contains `test` (the helpers refuse anything else), and the test Redis must be database 15 (it is flushed). The suite has more than 2,100 tests; the
integration tests use a real PostgreSQL and a real Redis and are never faked, only skipped when no test database is configured. There are no browser end-to-end tests ([testing](docs/testing.md)). CI (`.github/workflows/ci.yml`) runs typecheck,
lint, format, the full suite with disposable PostgreSQL and Redis containers, a fresh-UTF-8-database migration check, the build, and the production smoke script.

## Deployment

The application is two long-running processes (web and worker) plus PostgreSQL with pgvector, Redis, Clerk and Gemini. Server-sent events and the always-on worker make a persistent-process host the right fit, not
per-request serverless functions. Everything needed to release it (environment variables by process, migrations as a controlled step, health checks, security headers, rollback, keeping email disabled) is in
**[docs/deployment.md](docs/deployment.md)**.

## Documentation

- [Architecture](docs/architecture.md) · [Decisions (ADRs)](docs/decisions) · [Database](docs/database.md) · [API](docs/api.md) · [Testing](docs/testing.md)
- [Deployment](docs/deployment.md)
- [Authentication](docs/authentication.md) · [Authorization](docs/authorization.md) · [Server state (TanStack Query)](docs/server-state.md)
- [Customer management](docs/customer-management.md) · [Conversations and inbox](docs/conversations.md) · [Customer portal](docs/portal.md)
- [Knowledge base](docs/knowledge-base.md) · [RAG](docs/rag.md) · [AI agent](docs/ai-agent.md) · [AI conversation policy](docs/ai-conversation-policy.md) · [AI tools and approval](docs/ai-tools.md) · [Customer-facing AI](docs/customer-ai.md)
- [Automations and worker](docs/automations.md) · [Web chat widget](docs/widget.md) · [Realtime](docs/realtime.md)
- Email: [overview](docs/email.md) · [outbound](docs/email-outbound.md) · [operations](docs/email-operations.md) · [adapter contract](docs/email-adapter-contract.md) · [provider readiness](docs/email-provider-readiness.md)

## Known limitations

- **Email is not live.** Only an in-memory fake provider exists; it is refused in production, and no real provider, sending domain or DNS is configured. Delivery receipts, bounce handling and a suppression list are specified but not implemented.
- **No billing.** Stripe is a planned integration; nothing consumes the placeholder variables.
- **No browser end-to-end tests.** The widget loader and the Clerk sign-in flow are verified by unit, integration and manual/headless checks, not by an automated browser suite.
- **Held inbound email has no review screen** (it expires after a retention period), and the operator tool for unknown outbound email has no authenticated web UI (there is no platform-operator role).
- **The widget's "allowed websites" is a guard rail, not a browser-enforced restriction** ([deployment](docs/deployment.md#8-clerk-gemini-and-security-headers)).
- **Deployment is documented, not automated:** there is no Dockerfile or platform manifest, and behaviour behind a transaction-mode database pooler or during a Redis failover has not been exercised.
