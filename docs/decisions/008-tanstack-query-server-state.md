# 008 — TanStack Query for server state

Status: accepted

## Context

Through Phase 4 every mutation ended in `router.refresh()`, re-running the whole server render. That
made interactions feel slow, gave no pending/error/rollback model, and lost nothing-in-flight
protection (double submits, races between refetch and mutation).

## Decision

- Use `@tanstack/react-query` for all client-visible server state; pages remain server components that
  supply `initialData`.
- Key factories namespaced by organization; typed fetch client; per-feature hooks.
- Be **selectively optimistic**: only fast, easily reversible, low-risk changes (status, priority,
  assignment, read state, tags, archive). Messages use an outbox (pending/failed/retry) instead of
  cache insertion.
- **Not optimistic**: AI replies and knowledge publishing (server-generated or side-effectful).
- **Do not add Zustand**: there is no global client state; URL + React state cover UI state.
- Realtime (WebSockets/SSE/Redis) is deferred; polling-free refetch-on-focus is enough for now.

## Consequences

- Instant feedback with correct rollback; targeted invalidation instead of full refreshes.
- One cache per entity, no duplicated server state in components.

* More client code (hooks per feature) and `"use client"` boundaries around views.
* Multi-user changes are only seen on refetch until realtime exists.
