# Deployment guide

How to run the AI Customer Operations Platform outside a developer machine. Nothing in this guide deploys anything; it states what the application needs, in
the order a release performs it. Every statement about the code was checked against the repository; statements about a hosting product are marked as
guidance, because pricing and features change.

## 1. What runs, and why it is more than "a Next.js app"

| Process                        | Command                                               | Why it must exist                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web**                        | `npm run build` once, then `npm start` (`next start`) | The Next.js 16 app: UI, API routes, **server-sent events** for realtime (`/api/realtime/inbox`, `/api/widget/events`) and the public chat widget page.                      |
| **Background worker**          | `npm run worker` (`tsx scripts/automation-worker.ts`) | Consumes the BullMQ queue (automation runs, customer-facing AI replies, email wake-ups) and runs the maintenance loop (durable domain events, retention, health heartbeat). |
| **Migration (a release step)** | `npx prisma migrate deploy`                           | Applies pending database migrations. Run it deliberately, before the new web and worker start (section 6). Never from the web process.                                      |

Shared services: **PostgreSQL with the `pgvector` extension**, **Redis**, **Clerk** (authentication), **Gemini** (AI). Nothing else is required: email stays disabled (section 12).

```
Browser ──HTTPS──▶ Web (next start) ──▶ PostgreSQL (+pgvector)
   ▲  SSE            │   ▲                   ▲
   │                 ▼   │                   │
   └──── Redis ◀─────┴───┴──▶ Worker (npm run worker) ──▶ Gemini
                 Clerk ◀── Web (sessions)
```

## 2. Recommended architecture

**Requirement drivers.** The web tier holds long-lived connections (SSE streams stay open for minutes), the worker must be **always on** (it is the only thing that
runs queued jobs, retries unpublished events and writes the heartbeat that `/api/health/background` reads), and both need the same Redis.

**Recommendation: one platform with persistent processes, not serverless functions.** A container or PaaS host that offers (a) a long-running web service, (b) a
separate always-on background worker from the same repository, and (c) a managed Redis. Render (web service, background worker, key-value store), Railway and Fly.io
all fit; choose by the account you already have. A concrete, minimal layout:

| Component  | Where                                                                                                | Notes                                                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Web        | one service, 1 instance to start (scale to 2 later: it is stateless; Redis fans realtime events out) | Health check path `/api/health`. Must not sleep: free tiers that spin down break SSE and cold-start every visit. |
| Worker     | one background-worker service, 1 instance (more are safe: claims are atomic)                         | No HTTP port. Restart policy "always". Same repository and build as the web service, different start command.    |
| PostgreSQL | the existing Supabase project (pgvector is available)                                                | Use a **direct (non-pooled) connection** for migrations; see section 5 for the runtime connection.               |
| Redis      | the platform's managed Redis                                                                         | See section 7 (persistence and eviction policy matter for BullMQ).                                               |
| Monitoring | any external uptime monitor                                                                          | `/api/health/background` (section 9).                                                                            |

**Why not Vercel (or any function-per-request platform) for the web tier:** a request-scoped function cannot hold an SSE stream open indefinitely or host the worker.
The worker could live elsewhere and the web tier on Vercel, but then realtime is the part that breaks first; the layout above avoids the question.

**Operational complexity: moderate.** Two processes plus three external services (Postgres, Redis, Clerk) and one AI API; one migration step per release. Estimated first
setup: half a day to a day, most of it Clerk production-domain DNS and the first migration review. Steady state is low: no queue-draining or manual failover
procedure exists; the only recurring decisions are alerts on `/api/health/background` and reviewing `UNKNOWN` outbound emails (not applicable while email is disabled).

## 3. Build requirements

- **Node.js >= 22** (`engines` in `package.json`; CI uses 22).
- **Install with dev dependencies** (`npm ci`, and make sure the platform does not set `NODE_ENV=production` _during install_ or pass `--omit=dev`). The build needs `typescript`,
  `tailwindcss`/`@tailwindcss/postcss`, and the **`prisma` CLI** (the `postinstall` script runs `prisma generate`); the worker runs through **`tsx`** and migrations through `prisma`. Both are dev
  dependencies today. If your platform prunes dev dependencies after the build, run the worker and migrations from the pre-prune image or keep them installed.
- **Prisma client generation** is automatic (`postinstall`: `prisma generate` into `src/generated/prisma`, which is git-ignored). Run `npm run db:generate` after any schema change.
- `npm run build` needs **`NEXT_PUBLIC_*` variables at build time** (they are inlined into the browser bundle). It does not need runtime secrets and does not read the database.
- There is **no Dockerfile** in the repository. A buildpack-style build (`npm ci && npm run build`, then the start commands above) is sufficient.

## 4. Environment variables by process

Names only; never put values in the repository or in logs. `.env.example` has the same grouping. In production the **web process and the worker refuse to start** when a
required variable is missing, with a message that names the missing variables and nothing else (`src/lib/runtime-config.ts`; verified, see section 11). In development and in tests nothing
is required beyond `DATABASE_URL`.

| Variable                                                                                             | Build | Web | Worker | Production                                                                                      |
| ---------------------------------------------------------------------------------------------------- | :---: | :-: | :----: | ----------------------------------------------------------------------------------------------- |
| `NODE_ENV` (`production`)                                                                            |   x   |  x  |   x    | required                                                                                        |
| `DATABASE_URL`                                                                                       |       |  x  |   x    | required                                                                                        |
| `REDIS_URL`                                                                                          |       |  x  |   x    | required                                                                                        |
| `GEMINI_API_KEY`                                                                                     |       |  x  |   x    | required                                                                                        |
| `CLERK_SECRET_KEY`                                                                                   |       |  x  |        | required (web only)                                                                             |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`                                                                  |   x   |  x  |        | required (web; **also at build**)                                                               |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_URL`                                     |   x   |  x  |        | recommended (`/sign-in`, `/sign-up`)                                                            |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL`, `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` |   x   |  x  |        | recommended (`/dashboard`)                                                                      |
| `LOG_LEVEL`                                                                                          |       |  x  |   x    | optional (default `info`)                                                                       |
| `GEMINI_GENERATION_MODEL`, `GEMINI_EMBEDDING_MODEL`, `RAG_MIN_SIMILARITY`, `AI_TOOLS_ENABLED`        |       |  x  |   x    | optional (defaults in `src/server/ai/config.ts`)                                                |
| `AUTOMATION_QUEUE_DRIVER`, `REALTIME_DRIVER`                                                         |       |  x  |   x    | leave unset (`bullmq` / `redis` follow from `REDIS_URL`); `memory` is **refused** in production |
| `CSP_REPORT_ONLY`                                                                                    |       |  x  |        | optional: `true` = report, do not block (section 8)                                             |
| `EMAIL_PROVIDER`, `EMAIL_PLATFORM_DOMAIN`, `EMAIL_OUTBOUND_*`                                        |       |  x  |   x    | **leave unset** (section 12)                                                                    |
| `TEST_DATABASE_URL`, `TEST_REDIS_URL`                                                                |       |     |        | tests only; never set in a deployment                                                           |

Rules worth knowing: the **web process and the worker share only** `DATABASE_URL`, `REDIS_URL` and `GEMINI_API_KEY` (plus `NODE_ENV`); the worker never needs Clerk credentials. A value that
is present but malformed (a Clerk secret that does not start with `sk_`, an unknown enum) fails startup naming only the variable.

## 5. PostgreSQL (and Supabase)

- **Extension:** `pgvector`. The knowledge-base migration runs `CREATE EXTENSION vector`; the database role used for migrations must be allowed to (Supabase allows it).
- **Encoding:** the database must be **UTF-8**. A migration (`20261015000000_email_inbound_hardening`) refuses to run otherwise. Check with `SHOW server_encoding;`. CI creates a fresh `UTF8`, collation-`C` database and applies the whole chain to it.
- **Connections:** run `prisma migrate deploy` over a **direct (session-capable) connection**, not a transaction pooler: migrations use DDL and advisory locks. For the running web and worker, a direct connection
  is the verified configuration (the application uses `pg` through `@prisma/adapter-pg`, one pool per process, advisory locks are transaction-scoped). Running behind a transaction-mode pooler (for example
  Supabase's port 6543) was **not** verified; if you choose it, test the whole flow before relying on it.
- **Never** run `prisma db push`, `prisma migrate reset` or `prisma migrate dev` against a shared database (the last one can offer to reset it).

## 6. Releasing: migrations as a separate, controlled step

1. **Back up.** Take a snapshot (or confirm point-in-time recovery covers "now") immediately before. There are **no down migrations**.
2. **Inspect:** `npx prisma migrate status` (direct connection). It lists what is applied and pending. Read the pending migration SQL; the current pending chain adds the email tables, the domain-event outbox, the worker heartbeat and the outbound outbox. Two of them build indexes that lock writes to `messages` / `email_settings` briefly: run them in a quiet period.
3. **Apply:** `npx prisma migrate deploy` (applies pending migrations in order, each in a transaction where PostgreSQL allows).
4. **Roll out the new web and worker** only after step 3 succeeds. The migrations are additive, so the previous application version keeps working against the new schema during the rollout (it ignores new tables and columns).
5. **Verify** (section 11), then keep the previous release available for one rollback window.

**Rollback.** Application code: redeploy the previous release (safe while the schema is only additive). Schema: there is no automatic reverse; recovery is a restore from the step-1 backup, or a reviewed manual
SQL fix. An added enum value (`ConversationChannel.EMAIL`) cannot be removed. Treat "restore from backup" as the schema rollback plan and test the restore path once before you need it.

### Migration history and timestamps (owner decision recorded, nothing renamed)

The ten Phase 9 migrations are named `20261013000000_email_foundation` to `20261022000000_outbound_email_retry_budget`. Their timestamps are later than the date they were written. **What was verified:** `git` has one branch
(`main`), no stash, and no commit or reference in any history contains these names (they are untracked files); the real database was not queried. **What cannot be established from the repository:** whether any shared database
(the Supabase project, a staging copy, a teammate's database) already recorded some of them in `_prisma_migrations`. Because "absent from Git" does not mean "never applied", **the names were not changed**, and renaming one that
a database has already recorded would make `migrate deploy` treat the old name as missing and re-apply it (failing on existing objects).

**Owner action (needed once, before the first shared deployment):** run `npx prisma migrate status` against the Supabase project yourself. If it shows **none** of the Phase 9 migrations as applied, restamping is _possible_ but
not necessary; the safe default below works either way. If it shows **any** applied, never rename it.

**Safe path that works in both cases (adopted):** keep the names; create the next migration with `npx prisma migrate dev --create-only --name <name>` on a **local disposable database**, then rename its folder so the
timestamp is greater than `20261022000000` (for example `20261023000000_<name>`) **before** it is applied anywhere. `migrate deploy` applies unapplied migrations in name order and is unaffected; the rule only prevents `migrate dev` from
reporting a locally generated migration as out of order.

## 7. Redis (BullMQ and realtime)

- Needed by **both** the web process (enqueueing, realtime publish/subscribe) and the worker (consuming), at the same address. Use TLS (`rediss://`) when the provider offers it.
- BullMQ needs a real Redis with blocking commands: **not** an HTTP-only or serverless Redis API. Set the eviction policy to **`noeviction`** (BullMQ keeps its job state in Redis; eviction corrupts queues) and, if the provider allows, enable persistence (AOF).
- Jobs are hints, not the source of truth: PostgreSQL is. A Redis loss delays background work (the maintenance pass re-creates what is due) but loses no business data.
- The application uses the Redis database named in `REDIS_URL`. **Never** point `TEST_REDIS_URL` at a deployment Redis: the real-BullMQ tests flush database 15.

## 8. Clerk, Gemini, and security headers

**Clerk.** Create a production instance, add its domain records (a production instance serves its Frontend API from your own domain, `clerk.<your-domain>`), set the publisher key at **build** time and both keys at runtime. The sign-in/sign-up
URLs and fallback redirects are in `.env.example`. The application derives the Clerk Frontend API origin it must allow in its Content-Security-Policy from the publishable key.

**Gemini.** One server-side key (`GEMINI_API_KEY`) for generation and embeddings; it is never exposed to the browser. Quotas are the account's. Without the key the AI features answer 503, which is why production requires it.

**Security headers** (`next.config.ts`, `src/proxy.ts`, `src/lib/csp.ts`; tests in `src/lib/csp.test.ts` and `src/proxy.test.ts`):

| Where                                               | Headers                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every response                                      | `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` (camera, microphone, geolocation, payment, usb off), and in production `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no preload)                                                            |
| everything except the widget page                   | `X-Frame-Options: DENY`, and (pages and API handled by Clerk's proxy) a **strict nonce CSP** built by Clerk: `script-src 'self' 'nonce-…' 'strict-dynamic'` (no `https:` allowlist), plus our `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `data:`/`blob:` images and Clerk's Frontend API in `connect-src` |
| `/widget/*` (the embeddable chat page)              | its own nonce CSP (`script-src 'self' 'nonce-…' 'strict-dynamic'`, same-origin `connect-src`, no nested frames) and **no** `X-Frame-Options` and **no** `frame-ancestors`: any website may embed it                                                                                                                              |
| `/api/widget/*`, `/widget.js`, inbound-mail webhook | baseline headers only (JSON, server-sent events, a static script)                                                                                                                                                                                                                                                                |

`<ClerkProvider dynamic>` (in `src/app/(app)/layout.tsx`) is what puts the nonce on Clerk's own scripts; without it the policy blocks them (found and fixed during verification).

**Which websites may start a chat is NOT decided by the browser.** The widget's "allowed websites" setting is checked by `/api/widget/session` against the embedding page's reported origin (a client-supplied value, so it is a guard rail, not
an authentication boundary). Browser-enforced per-organization `frame-ancestors` (a database lookup in the proxy) is **not implemented**; the widget key is public by design and visitors have no privileges.

**Honest limits.** `style-src` keeps `'unsafe-inline'` (React `style` attributes, Tailwind runtime values and Clerk's injected styles cannot be nonced; scripts are not affected). Clerk's merge also lists Stripe and Google Maps origins this
application does not use and cannot be asked to drop them. **First deployment:** set `CSP_REPORT_ONLY=true` for the first release, sign in once, open the widget, and watch the browser console for violations; remove the variable to enforce.
The Clerk sign-in flow with real keys could not be exercised in the repository's verification (it needs a live Clerk instance); everything else below was.

## 9. Health checks and monitoring

| Endpoint                     | Answers                                                                                                                                                       | Use it for                                                                                                                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/health`            | the **web tier**: the process serves and PostgreSQL answers (`200` / `503`)                                                                                   | The platform's liveness/readiness probe for the web service.                                                                                   |
| `GET /api/health/background` | the **worker tier**, computed from PostgreSQL only: worker heartbeat age, oldest unpublished domain event, oldest due outbound email (`200` / `503` degraded) | An **external uptime monitor / alert**, not an orchestrator probe: a stopped worker must page someone, not remove web instances from rotation. |

They are separate on purpose and unauthenticated (coarse states and numbers only, nothing tenant-specific). Verified end to end: with only the web process running, `/api/health` is 200 and `/api/health/background` is 503; once a worker
runs, both are 200. Neither checks Redis directly: a Redis outage shows up as a stale worker or growing due work. Structured metrics are emitted as log lines (`module: "metrics"`); alert proposals are in `docs/email-operations.md`.

## 10. Backups

PostgreSQL holds all business data; Redis holds only transient job state. Back up PostgreSQL (provider snapshots or PITR) and **test a restore**. Take a snapshot before every migration. The application stores no uploaded files.

## 11. Verify a release (smoke checklist)

1. `scripts/smoke-production.sh` against the built application with throwaway placeholders and a disposable local database and Redis (it refuses a non-local `DATABASE_URL` or `REDIS_URL` unless `SMOKE_ALLOW_NONLOCAL=1`; it is also a CI step, run against the fresh migrated database): incomplete configuration exits naming only variables; complete configuration serves with the promised headers; the widget page is frameable and its nonce changes per request; `/api/health/background` reports the missing worker.
2. After deploy: `/api/health` is 200; start the worker; `/api/health/background` becomes 200 within a couple of minutes.
3. Sign in; open the dashboard (`CSP_REPORT_ONLY=true` the first time); no CSP violations in the console.
4. Embed `<script src="https://YOUR-APP/widget.js" data-key="wk_..." async></script>` on a page on **another origin**, open the chat, send a message; it appears in the inbox in real time.
5. Open `/sign-in` inside an iframe on another origin: it must be refused.

## 12. Keeping email disabled

Email must stay off in every deployment until a real adapter exists, is verified and approved (`docs/email-provider-readiness.md`). Enforcement, in layers: leave `EMAIL_PROVIDER` and `EMAIL_PLATFORM_DOMAIN` **unset**; `EMAIL_PROVIDER` accepts only `fake`; the fake
is refused by environment validation, by the sender and by the capability policy in production; the only `EmailProvider` implementation in the code is the fake (`src/server/email/production-boundary.test.ts` fails if that changes); organizations cannot enable email
without a configured provider and domain.

## 13. Known gaps

- No Dockerfile or platform manifest; the guide above is the contract.
- The Clerk sign-in flow under the strict CSP could not be driven with real credentials here; use `CSP_REPORT_ONLY=true` for the first deployment.
- Per-organization `frame-ancestors` for the widget is not implemented (section 8).
- Behaviour behind a transaction-mode database pooler and under a Redis failover was not exercised.
- CI cannot run the Clerk-dependent flows; it runs the unit/integration suites, the real BullMQ tests, a fresh-database migration check and the production smoke script.
