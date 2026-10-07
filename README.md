# AI Customer Operations Platform

Multi-tenant SaaS for managing customers, AI agents, conversations, workflows, knowledge bases and
campaigns. Built as a modular monolith on Next.js, PostgreSQL and (later) BullMQ.

> Status: **Phase 4** - authentication (Clerk), organizations, RBAC and tenant isolation, customer
> management, conversations with a shared inbox, and a **knowledge base with RAG and an AI support
> agent** (Gemini + PostgreSQL/pgvector) that drafts grounded replies inside conversations.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 + shadcn/ui · Clerk ·
PostgreSQL + Prisma 7 · Zod · Pino · Gemini (`@google/genai`) + pgvector · Vitest + React Testing Library

Planned: Stripe (test mode), BullMQ/Redis, pgvector, React Flow, Playwright.

## Getting started

Requirements: Node.js >= 22, Docker (for local Postgres/Redis).

```bash
npm install
cp .env.example .env        # add your Clerk keys and GEMINI_API_KEY
docker compose up -d        # Postgres (pgvector) + Redis
npm run db:deploy           # apply migrations
npm run dev                 # http://localhost:3000, health: /api/health
```

## Scripts

| Script                             | Purpose                                                      |
| ---------------------------------- | ------------------------------------------------------------ |
| `npm run dev` / `build` / `start`  | Next.js                                                      |
| `npm run typecheck`                | `tsc --noEmit`                                               |
| `npm run lint` / `format:check`    | ESLint / Prettier                                            |
| `npm test`                         | Vitest                                                       |
| `npm run check`                    | typecheck + lint + format check + tests                      |
| `TEST_DATABASE_URL=... npm test`   | Also runs DB integration tests ([docs](docs/testing.md))     |
| `npm run ai:smoke`                 | Real Gemini check (3 requests); prints scores, never the key |
| `npm run db:seed -- --org <slug>`  | Dev-only fake customers for an existing organization         |
| `npm run db:migrate` / `db:deploy` | Create+apply (dev) / apply (CI, prod)                        |

## Documentation

- [Architecture](docs/architecture.md)
- [Customer management](docs/customer-management.md) · [Conversations & inbox](docs/conversations.md)
- [Knowledge base](docs/knowledge-base.md) · [RAG](docs/rag.md) · [AI agent](docs/ai-agent.md)
- [Authentication](docs/authentication.md) · [Authorization](docs/authorization.md) · [API](docs/api.md)
- [Database](docs/database.md)
- [Testing](docs/testing.md)
- [Decisions (ADRs)](docs/decisions)
