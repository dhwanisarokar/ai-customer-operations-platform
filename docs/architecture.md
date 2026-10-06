# Architecture

A **modular monolith**: one Next.js deployable plus (later) a BullMQ worker process sharing the same
codebase and database.

```text
src/
├── app/            Routes and API handlers. Thin: parse/validate input, call a service, shape the response.
├── db/             Prisma client access.
├── generated/      Prisma client output (gitignored, produced by `prisma generate`).
├── lib/            Small, single-purpose modules (env, logger). No grab-bag utils file.
└── server/
    └── services/   Application logic. Feature folders (`src/features/*`) and
                    `repositories/`, `jobs/`, `integrations/` are added when the first
                    feature needs them, not before.
```

## Rules

- No business logic in React components or route handlers; they call services.
- Services own authorization and tenant scoping. Data access never trusts client-supplied org ids.
- All external input is validated with Zod. Environment is validated once in `src/lib/env.ts`.
- Logging goes through `src/lib/logger.ts` (Pino, structured, secrets redacted).
- The AI provider is only reachable through a dedicated service abstraction (to be added).

## Current surface

- `GET /api/health` — returns 200 `{status:"ok"}` or 503 `{status:"degraded"}` depending on DB reachability.
