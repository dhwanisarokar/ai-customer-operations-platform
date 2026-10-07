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

### Outbox and delivery state (messages and notes)

```text
TanStack Query cache      -> persisted server messages (real ids)
Component state (outbox)  -> the user's in-flight messages (clientId, sending | sent | failed)
ConversationPane          -> merges both into ONE list for the timeline
```

A message the user sends is rendered immediately as a **normal message bubble** (same component as
persisted messages) with a small delivery icon next to the time: clock (sending), check (sent),
warning (failed, with Retry/Discard in the bubble). There is no separate "Sending..." row.

Reconciliation is by **identity, never by text or timestamp**:

1. `useOutbox` gives each item a client-only `clientId`; the same item goes through every state.
2. On success `useSendMessage.onSuccess` writes the real message into every matching messages cache
   (idempotent by server id) and the item becomes `sent` with that `serverId`.
3. The pane renders the persisted message (matched by `serverId`) in place of the temporary entry,
   keeping the `clientId` as its React key and showing the check icon. An item is rendered as
   temporary only while no persisted message with its `serverId` exists, so one copy is ever visible,
   whatever order the cache and component updates land in, including during the follow-up refetch.
4. Retry re-sends the same failed item (status goes failed -> sending -> sent). Only `failed` items
   can be retried, so a retry can never post a message that was already accepted.

The follow-up invalidation (`refreshConversation`) is fire-and-forget: it is not returned from
`onSettled`, otherwise the mutation would stay pending until the refetch finished.

AI generation is separate UI state, and its result is a **draft**, not a message:

```text
Ask AI -> useAiDraft (mutation; isPending = "Generating AI draft...")
       -> draft held in ConversationPane state -> MessageComposer `suggestion` (single box, banner, Discard / Send)
       -> Send -> the same outbox.send used for typed replies
```

`POST /ai-draft` stores nothing, so `useAiDraft` writes nothing to the cache and invalidates nothing.
Asking again replaces the draft. On failure there is no draft and the error shows.

### Deliberately NOT optimistic

- **AI draft** — generated and grounded on the server; the UI shows "Generating AI draft..." and then an
  editable draft that a human must send explicitly. Errors show the safe API message.
- **Knowledge create/update/publish/unpublish/archive/delete** — publishing indexes embeddings and
  can fail; the UI shows "Indexing and publishing..." and waits.

## Limitations

- No realtime: other users' changes appear on refetch (window focus, reconnect, navigation, stale).
- The outbox lives in component state; unsent/failed messages are lost on navigation or reload
  (the "sent" check icon of earlier messages likewise only lasts for the open conversation).
- A network failure after the server stored a message looks like a failed send; retrying would then
  post a duplicate (no idempotency key yet).
- The events timeline fetches a window of 100; the messages view loads the newest 50 ("Load earlier").
- The Next.js client router cache can briefly show a prior server render before the query refetches.

## AI approvals

`useAiApprovals(conversationId)` reads the pending actions (initial data from the server page) and
`useDecideApproval` approves/rejects. Not optimistic: the server executes and may refuse. After a
decision it refetches the approvals, conversation, lists, events and customers. See
[ai-tools.md](ai-tools.md).
