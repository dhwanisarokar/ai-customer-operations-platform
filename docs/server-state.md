# Server state (TanStack Query)

Phase 4.5 moved all client-side server data to TanStack Query. Pages stay server components: they
load the first page of data in the server, pass it down as `initialData`, and client views take over
(refetching, mutations, optimistic updates).

## Server state vs client state

| Kind         | Examples                                        | Where it lives                |
| ------------ | ----------------------------------------------- | ----------------------------- |
| Server state | customers, conversations, messages, knowledge   | TanStack Query cache          |
| URL state    | filters, search, sort, page, selected `?c=` id  | the URL (shareable, back/fwd) |
| Local UI     | open menus, composer text, "load earlier" limit | React `useState`              |

**Zustand is not used.** There is no genuinely global client state, so adding a store would only
duplicate the URL or the query cache. Add one only when such state appears.

## Layout

- `src/lib/api-client.ts` — typed `fetchJson` (no Axios); throws `ApiError` (status, code, field errors).
- `src/lib/query/` — `query-client.ts` (defaults, stale times), `query-provider.tsx`, `query-keys.ts`,
  `optimistic.ts`, `outbox.ts`, `serialize.ts`.
- `src/features/<feature>/api/` (types + request builders) and `hooks/{queries,mutations}.ts`.
- `src/app/dashboard/layout.tsx` is an async server layout that mounts `QueryProvider`.

## Query keys

Every key is built by a factory in `query-keys.ts` and starts with `["org", organizationId, ...]`,
so switching organization can never show another organization's cached data. This namespacing is
cache hygiene only; **authorization stays on the server** (every API call re-checks the session).
Filters, search, sort and page are part of list keys, and lists use `keepPreviousData` so pagination
and filter changes do not flash empty.

## Initial data from the server

`serialize()` JSON-round-trips service results (Date -> ISO string) so `initialData` has exactly the
API's JSON shape. Initial data is fresh for the feature's stale time, then refetches normally.

## Stale times

conversations 15s · messages 10s · customers 60s · tags 2m · members 5m · knowledge 5m; gc 5m.
4xx errors are never retried; other failures retry once. Mutations do not retry.

## Mutations and invalidation

Mutations call the same REST API and then invalidate **targeted** keys (the affected detail and the
lists of that feature) rather than everything. `mutationKeys` allow `useIsMutating` for pending UI.

### Optimistic updates (selective)

Optimistic with snapshot -> rollback -> reconcile (`optimistic.ts`): conversation status, priority,
assign/unassign, mark-read; customer tags add/remove; archive customer. Flow: cancel in-flight
queries for the keys, snapshot, patch the cache, on error restore the snapshot and show the server's
message, on settle invalidate. Overlapping mutations on one key only reconcile after the last one.

### Outbox (messages and notes)

New messages and notes are not inserted into the cache. `useOutbox` keeps pending/failed items in
component state, rendered as "Sending..." or a failed row with **Retry**/**Discard**. On success the
item leaves the outbox and the list is invalidated, so the confirmed server row replaces it.

### Deliberately NOT optimistic

- **AI reply** — the content is generated and grounded on the server; we show "AI Agent is writing a
  reply..." and only render the real message on success. Errors show the safe API message.
- **Knowledge create/update/publish/unpublish/archive/delete** — publishing indexes embeddings and
  can fail; the UI shows "Indexing and publishing..." and waits.

## Limitations

- No realtime: other users' changes appear on refetch (window focus, reconnect, navigation, stale).
- The outbox lives in component state; unsent/failed messages are lost on navigation or reload.
- The events timeline fetches a window of 100; the messages view loads the newest 50 ("Load earlier").
- The Next.js client router cache can briefly show a prior server render before the query refetches.
