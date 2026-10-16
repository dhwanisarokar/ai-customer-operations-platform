# Automations

Phase 6 adds a deterministic automation engine: **WHEN** an event happens **AND** (optional) conditions
match **THEN** run one or more actions. Rules are plain data evaluated by plain code. No model decides
whether an automation matches or what it does (see
[ADR 010](decisions/010-deterministic-automation-engine.md)).

```text
service change commits
      |
      v
emitDomainEvent(type, data)            src/server/events/bus.ts
      |  (best effort; never breaks the request)
      v
engine.dispatchDomainEvent             src/server/automation/engine.ts
  1. enabled automations of THIS organization for the trigger
  2. evaluate conditions (deterministic)
  3. INSERT automation_execution  (unique: organization + automation + event id)
  4. enqueue { executionId }
      |
      v
queue (BullMQ/Redis, or in-process in development)
      |
      v
worker: processAutomationJob           src/server/automation/runner.ts
  load execution from PostgreSQL -> claim atomically -> run actions in order -> record results
```

## Domain events

Typed facts emitted by the application services **after** the database transaction committed, so a
failed transaction never emits and routes never duplicate service logic (`src/server/events`).

| Event                             | Emitted by                                            | Data (ids and enum values only)                                                                      |
| --------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `customer.created`                | `createCustomer`                                      | customerId, status, company, source                                                                  |
| `customer.updated`                | `updateCustomer` (only if a field really changed)     | customerId, status, company, changedFields                                                           |
| `conversation.created`            | `createConversation`                                  | conversationId, customerId, priority, status, channel                                                |
| `conversation.status_changed`     | `updateConversation`; a customer message that reopens | conversationId, customerId, status, previousStatus, priority, assignee                               |
| `conversation.priority_changed`   | `updateConversation`                                  | conversationId, customerId, priority, previousPriority, status, assignee                             |
| `conversation.assigned`           | `assignConversation` (only if the assignee changed)   | conversationId, customerId, assignee, previousAssignee, status, priority                             |
| `message.created`                 | `sendMessage`                                         | messageId, conversationId, customerId, senderType, messageType, body (conditions only, never stored) |
| `customer.tag_added` / `_removed` | `addTagToCustomer` / `removeTagFromCustomer`          | customerId, tagId, tagName                                                                           |

The organization of an event is the authenticated context of the service that emitted it, never client
input. Every event has a stable `id`. Events caused by an automation's own action are flagged
(`causedByAutomation`) and **never trigger automations**, so there are no loops.

## Registries

- **Triggers** (`catalog.ts` -> `triggers.ts`): name, description, the condition **fields** the event
  supports (typed: string, id, enum, number, list) and which records actions can act on. The dashboard
  builder and the server validate against the same catalog.
- **Conditions** (`conditions.ts`): `equals`, `not_equals`, `contains`, `not_contains`, `exists`,
  `greater_than`, `less_than`, ANDed. Operators must fit the field's type; enum values must be valid;
  unsupported fields/operators are rejected on save. Evaluation records `expected`, `actual` and
  `passed` per condition (never `actual` for sensitive fields such as message text).
- **Actions** (`actions.ts`): `add_customer_tag`, `remove_customer_tag`, `assign_conversation`,
  `change_conversation_status`, `change_conversation_priority`, `create_customer_note`. Each has a strict
  Zod `inputSchema`, a `requiredPermission` and an `execute()` that calls the **existing services**
  (status transitions, tag rules, "assignee must be a member"...). The target record (customer /
  conversation) comes from the event, never from the definition.

Adding a trigger or an action means adding a catalog entry (and an executor); the engine does not change.

## Data model

- `automations`: name, description, `enabled`, `triggerType`, `conditions` and `actions` (validated JSON
  lists), `createdByUserId`. Composite unique `(id, organizationId)`; CHECKs for shape.
- `automation_executions`: one row per (automation, event), **unique on
  `(organizationId, automationId, eventId)`**; status `QUEUED | RUNNING | COMPLETED | FAILED | CANCELLED`,
  attempts, timestamps, safe `errorCode`/`errorMessage`, minimal `eventData`, a `definition` snapshot (what
  matched), `conditionResults` and per-action `actionResults`. Composite FK to `automations`.

## Lifecycle, idempotency and retries

1. A matching event inserts the execution. The unique key makes this the idempotency point: replaying
   the same event id (or two instances dispatching it) creates **one** execution.
2. The queue carries only `{ executionId, organizationId }` (job id = execution id, so the queue
   deduplicates too).
3. The worker loads the execution from PostgreSQL. A finished run is never re-run. If the automation was
   **disabled** meanwhile, the run is `CANCELLED`.
4. **Atomic claim:** `QUEUED -> RUNNING` (or `RUNNING` with a lock older than 5 minutes: a crashed worker)
   in one guarded update. Exactly one worker wins, however many deliver the job.
5. Actions run **sequentially**; each result is saved. On retry or takeover, actions already `completed`
   are skipped. (A crash between an action's effect and its recorded result can repeat that one action:
   delivery is at-least-once; tag/assign/status actions are idempotent, a note could duplicate.)
6. **Errors:** business-rule/authorization errors (`NOT_FOUND`, `FORBIDDEN`, conflicts such as an invalid
   status transition) are permanent -> `FAILED` immediately. Unexpected errors are retried by the queue
   with exponential backoff (BullMQ: up to **5 attempts**, 2 s base) and the run is `FAILED` after the last
   attempt. Only a safe error code/message is stored; raw errors are logged server-side.
7. If the queue is unreachable when an event matches (e.g. Redis down), the execution is recorded as
   `FAILED / QUEUE_UNAVAILABLE` so it is visible. It is not re-queued automatically.

### Run history: previous values and member names

Ids stay the authoritative value everywhere they are stored (definitions, event data, condition and
action results). Only the run detail presentation changes:

- A condition's note is `(was <value before the change>)` when the trigger field has a "before"
  counterpart declared in the catalog (`priority` -> `previousPriority`, `status` -> `previousStatus`,
  `assignee` -> `previousAssignee`), read from the event itself. Other fields show `(value: <evaluated>)`.
  The stored `actual` is the value of the evaluated field (the new value); it is never labelled "was".
- Member ids (fields marked `ref: "member"` in the catalog and action inputs listed in `memberFields`) are
  shown as the member's name. `GET .../executions/:executionId` returns `execution.memberNames`, built with
  **one** organization-scoped query (`membershipsRepository.listByUserIds`) for every member the run mentions.
  A member who left, or an id from another organization, has no entry and is shown as "Former member".

## Performance: where the time goes

Measured with `npm run bench:automation` (a scratch database, a real BullMQ worker and Redis; every
database round trip is counted and can be delayed with `BENCH_DB_RTT_MS` to imitate a remote database).
Typical result for "priority -> URGENT -> tag + assign -> COMPLETED":

| Stage                                                                                        | Local DB (0 ms) | 40 ms round trip | 100 ms round trip |
| -------------------------------------------------------------------------------------------- | --------------- | ---------------- | ----------------- |
| Request until success (10 statements are the conversation update itself, 2 are the dispatch) | 17 ms           | 484 ms           | 1100 ms           |
| Redis enqueue, then worker pick-up                                                           | ~2 ms           | ~2 ms            | ~3 ms             |
| Worker set-up (load, claim, creator context)                                                 | 6 ms            | 197 ms           | 435 ms            |
| Each action (its service runs ~10 statements)                                                | ~9 ms           | ~425 ms          | ~990 ms           |
| Final update                                                                                 | 1.5 ms          | 46 ms            | 116 ms            |
| **Change -> COMPLETED**                                                                      | **~45 ms**      | **~1.6 s**       | **~3.8 s**        |

Redis/BullMQ are not the bottleneck (a few milliseconds). The cost is **sequential database round trips**
(about 12 on the request and 28 in the worker), each paying the network latency to the database. From a
developer machine to a remote Supabase project (measured: median ~108 ms per round trip) that is seconds;
with the app, worker and database in the same region (1-5 ms) the same run takes well under 200 ms. Run
the web app and the worker in the database's region in production.

Optimizations that keep every guarantee (idempotency, ordered actions, no repeated actions on retry,
creator authorization re-checked per run): the creator's user, membership and organization are loaded in
one call and **concurrently with the atomic claim**; the last action's result is stored by the final
update instead of a separate progress write (the "effect applied -> recorded" window is unchanged).
Actions stay sequential because order matters, and each other action still records progress before the
next one starts.

In the browser, a conversation priority/status/assignment change is shown immediately (optimistic), and
the conversation is refreshed again after 1.5 s, 4 s and 8 s so the automation's own changes appear
without a manual refresh; run history polls every 1.5 s while a run is queued or running.

## Security model

- Every API call and query is scoped by the session's organization; another tenant's automation or
  execution id is `404`. Bodies are strict: `organizationId`, `createdByUserId` or any other key is
  rejected (`400`), never ignored.
- RBAC (existing system): `view_automations` (all roles), `create_automations`, `update_automations`
  (also enable/disable), `delete_automations`, `execute_automations` (dry run) for ADMIN and OWNER.
- **An automation acts with its creator's permissions.** On save the creator must hold the permission
  of every action (no privilege escalation through an automation) and any referenced assignee must be a
  member of the organization. On **every run** the worker rebuilds a trusted context from the creator's
  _current_ membership: a demoted or removed creator makes actions fail with `FORBIDDEN`. The services
  then enforce permissions and tenant scope again.
- Event data is minimal and message text is never persisted. Logs carry ids, event type and action name
  only (no payloads, no customer data, no prompts).

## API

`GET/POST /api/automations`, `GET/PATCH/DELETE /api/automations/:id`,
`POST /api/automations/:id/enable|disable`, `GET /api/automations/:id/executions`,
`GET /api/automations/:id/executions/:executionId`, `POST /api/automations/:id/test` (dry run: evaluates
the conditions against sample data and lists the actions with whether the caller may run them; executes
nothing). Validation errors return `{ error: { code: "validation_error", details: { problems: [...] } } }`.
See [api.md](api.md).

## UI

Dashboard -> **Automations**: list (enable/disable), builder (WHEN trigger, AND conditions, THEN
actions), execution history (refreshes while runs are queued/running) and a run detail page showing the
event, each condition (passed/failed with the actual value) and each action (result, error). Server state
is TanStack Query; there is no global client state.

## Running the worker

Redis and BullMQ are the shared background-job infrastructure: the one queue (and the one worker process below) runs automation runs, customer-facing AI replies
([customer-ai](customer-ai.md)) and outbound email wake-ups ([email-outbound](email-outbound.md)). A job carries ids only, never message text or addresses; PostgreSQL stays the
source of truth, so a lost job is recreated from the database. Redis also carries the realtime pub/sub between instances ([realtime](realtime.md)).

```bash
docker compose up -d redis          # or any Redis (BullMQ recommends 6.2+; compose uses 7)
# .env: REDIS_URL=redis://localhost:6379   (and the usual DATABASE_URL)
npm run dev                         # web app: emits events, enqueues runs
npm run worker                      # in a second terminal: consumes the queue
```

- **Without Redis** (development only): set `AUTOMATION_QUEUE_DRIVER=memory` (or leave `REDIS_URL`
  unset). Runs then execute inside the web process; nothing survives a restart.
- **Production:** run `npm run worker` as its own process (same image/env as the web app) next to the web
  process; scale workers horizontally (the atomic claim keeps runs single). The worker handles
  SIGINT/SIGTERM gracefully (running jobs finish before it exits). Point `REDIS_URL` at a managed Redis
  with persistence (AOF) so queued runs survive a Redis restart.
- A run that stays `QUEUED` means no worker is consuming the queue.

## Limitations

- Conditions are AND only (no OR/groups); no delays, loops or branching; one action list.
- Actions are attributed to the automation's creator (events/activities show that user).
- Failed runs are not retried manually from the UI; fix the cause and trigger a new event.
- Events are emitted in the request that caused them (best effort): a crash between commit and emit
  loses that event (no outbox table yet).
- History is paged at 50 runs.

## Shared queue: customer-facing AI replies

The same BullMQ queue and `npm run worker` process also run the web chat assistant's jobs (`kind: "customer-ai"`, see [customer-ai](customer-ai.md)). The worker therefore needs the AI provider configuration (`GEMINI_API_KEY`) in addition to `DATABASE_URL` and `REDIS_URL`.
