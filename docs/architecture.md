# Architecture

A **modular monolith**: one Next.js deployable plus (later) a BullMQ worker process sharing the same
codebase and database.

```text
src/
├── app/            Routes and API handlers. Thin: parse/validate input, call a service, shape the response.
├── db/             Prisma client access.
├── generated/      Prisma client output (gitignored, produced by `prisma generate`).
├── features/       Feature-specific schemas, helpers and client components (organizations so far).
├── lib/            Small, single-purpose modules (env, logger). No grab-bag utils file.
└── server/
    ├── auth/       Clerk adapter (identity.ts), tenant context, permissions.
    ├── ai/         Provider interface, Gemini adapter, embeddings, config, the support agent.
    ├── http/       API handler wrapper (error mapping, JSON parsing), param helpers.
    ├── repositories/  Prisma queries; org-scoped functions take an explicit organizationId.
    └── services/   Application logic and authorization rules.
                    `jobs/` and `integrations/` are added when the first feature needs them.
```

## Rules

- No business logic in React components or route handlers; they call services.
- Services own authorization and tenant scoping. Data access never trusts client-supplied org ids.
- All external input is validated with Zod. Environment is validated once in `src/lib/env.ts`.
- Logging goes through `src/lib/logger.ts` (Pino, structured, secrets redacted).
- The AI provider is only reachable through a dedicated service abstraction (to be added).

## Current surface

- Auth, organizations, memberships and RBAC: see [authentication](authentication.md) and
  [authorization](authorization.md). Endpoint reference: [api](api.md).
- Customers: [customer management](customer-management.md). Conversations and the inbox:
  [conversations](conversations.md). Each feature follows the same route -> service -> repository
  layering with an explicit organization on every query.
- Knowledge base, RAG and the AI agent: [knowledge-base](knowledge-base.md), [rag](rag.md),
  [ai-agent](ai-agent.md). All AI access goes through `src/server/ai` (a provider interface with one
  Gemini implementation); services and routes never import the SDK. A deterministic conversation
  policy ([ai-conversation-policy](ai-conversation-policy.md)) runs before retrieval and answers
  small talk, off-topic and injection attempts without RAG or a model call.
- Client server-state (TanStack Query, optimistic updates, outbox): [server-state](server-state.md).
  Pages load initial data on the server; client views refetch and mutate through the same REST API.
- AI tools, deterministic authorization and human approval: [ai-tools](ai-tools.md). The model may
  request an action; only application code authorizes and executes it. Tools call the existing
  services (`src/server/ai/tools`), mutations wait in `ai_action_approvals` for a human.
- Automations: [automations](automations.md). Services emit typed domain events after commit; a deterministic
  engine matches enabled automations, records one execution per (automation, event) (unique key =
  idempotency) and a BullMQ worker (`npm run worker`) runs the actions through the existing services with the
  automation creator's current permissions. PostgreSQL is the source of truth; Redis only carries execution ids.
- `GET /api/health` — returns 200 `{status:"ok"}` or 503 `{status:"degraded"}` depending on DB reachability.
- Web chat widget and realtime: [widget](widget.md), [realtime](realtime.md). Visitors are anonymous
  sessions (not users or members) that reach only a dedicated public API (`/api/widget/*`); their chats
  are normal conversations (`WEB_CHAT`) written through the same services via an `Actor` abstraction.
  Realtime is SSE hints published after commit (Redis pub/sub between instances); clients refetch from the
  authorized API. See ADR [011](decisions/011-visitor-sessions-and-sse-realtime.md).
- Customer-facing AI replies (web chat): [customer-ai](customer-ai.md), ADR
  [012](decisions/012-customer-facing-ai-read-only.md). A read-only path (no tools, no customer record)
  on the existing queue; the internal draft workflow is unchanged.
- Customer portal: [portal](portal.md), ADR [014](decisions/014-customer-portal-identity-linking.md). A third
  authorization context (an authenticated customer, via an explicit invitation-created link) next to staff and
  anonymous visitors; conversations reuse the existing domain through a `portal` actor.
