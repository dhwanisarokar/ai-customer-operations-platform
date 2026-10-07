# Database

PostgreSQL 17 (pgvector image locally) accessed through Prisma 7 with the `@prisma/adapter-pg` driver
adapter. Schema: `prisma/schema.prisma`. Migrations: `prisma/migrations` — never edit a deployed
schema by hand.

## Conventions

- Table names are plural snake_case via `@@map`; primary keys are UUIDs.
- Every org-owned table has a non-null `organizationId` FK to `organizations` and composite indexes
  that lead with `organizationId`, since all tenant queries filter on it.
- Indexes are added for a concrete query and documented here with the reason.
- Multi-step writes use transactions.

## Current tables

| Table           | Notes                                                                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| `users`         | Local identity. `authProviderId` (Clerk id) and `email` are unique. No credentials stored.                   |
| `organizations` | Tenant root. Unique `slug`; CHECK constraints: non-blank `name`, `slug` format and length.                   |
| `memberships`   | `userId` + `organizationId` (both FK, `ON DELETE CASCADE`) + `role` enum. Unique `(userId, organizationId)`. |

`Role` is a PostgreSQL enum: `OWNER`, `ADMIN`, `MEMBER`.

### Indexing decisions

- `memberships (userId, organizationId)` UNIQUE: enforces one membership per pair, and its leading
  `userId` column serves "list this user's organizations" and the hot tenant-gate lookup
  ("is user U in organization O?") on every request.
- `memberships (organizationId, role)`: "list an organization's members" and role counts (e.g. owner
  checks). Leads with `organizationId` like all tenant queries will.
- `users.authProviderId` UNIQUE: lookup on every authenticated request. `users.email` UNIQUE:
  add-member-by-email lookup and one-account-per-email.
- `organizations.slug` UNIQUE: slug uniqueness and lookup by slug.

### Hand-written migration

`20261006113500_organization_check_constraints` adds CHECK constraints that Prisma's schema language
cannot express. All other migrations are Prisma-generated and unedited. Keep the constraints in sync
with `src/features/organizations/slug.ts`.

## Workflow

```bash
npm run db:migrate   # dev: create + apply a migration after editing schema.prisma
npm run db:deploy    # CI/prod: apply committed migrations
```

The `vector` extension will be enabled by a migration (`CREATE EXTENSION vector`) when the knowledge
base is built.

## Customer tables (Phase 2)

| Table                 | Notes                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `customers`           | Tenant-owned. `UNIQUE (organizationId, email)` and `(organizationId, externalId)`; `UNIQUE (id, organizationId)`; status enum. |
| `tags`                | `UNIQUE (organizationId, normalizedName)` (case-insensitive names); `UNIQUE (id, organizationId)`.                             |
| `customer_tags`       | PK `(customerId, tagId)`; composite FKs to customers and tags on `organizationId`, so cross-tenant links are impossible.       |
| `customer_activities` | Timeline. Composite FK to customers; `actorId` is intentionally not a FK. Enums `ActivityType`, `ActivityActorType`.           |
| `customer_notes`      | Composite FK to customers; `authorId` FK to users with `ON DELETE SET NULL`.                                                   |

Rules and the full index rationale are in [customer management](customer-management.md). The
tenant-consistency pattern is [ADR 005](decisions/005-composite-foreign-keys-for-tenant-consistency.md).

`20261007064200_customer_check_constraints` is hand-written (Prisma cannot express CHECK
constraints): non-blank names/titles/content, lowercase email, phone format `^\+?[0-9]{5,15}$`,
and `status = ARCHIVED` if and only if `archivedAt IS NOT NULL`. `tags.normalizedName` is not
checked against `lower(name)` because PostgreSQL and JavaScript lowercase some non-ASCII text
differently. `customers.updatedAt` has a default and is set by the application on profile edits
(not Prisma's `@updatedAt`) so timeline bookkeeping never counts as an edit.

## Conversation tables (Phase 3)

| Table                      | Notes                                                                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conversations`            | Composite FKs to `customers(id, organizationId)` and (nullable assignee) `memberships(userId, organizationId)` with `NO ACTION`. Denormalized `lastMessage*` / `lastCustomerMessageAt`. |
| `messages`                 | Composite FK to conversations. `senderUserId` FK to users `SET NULL`. Enums `MessageSenderType`, `MessageType`.                                                                         |
| `conversation_events`      | Composite FK to conversations. `actorId` is not a FK. Enum `ConversationEventType`.                                                                                                     |
| `conversation_read_states` | PK `(conversationId, userId)`; composite FKs to conversations and to memberships (`CASCADE`).                                                                                           |

Enums: `ConversationStatus`, `ConversationPriority`, `ConversationChannel` (only `IN_APP`).
Design and decisions: [conversations](conversations.md), [ADR 006](decisions/006-conversation-tenant-integrity.md).

### Indexing decisions

All tenant queries lead with `organizationId`. The conversation indexes are
`(organizationId, status, lastMessageAt DESC)` for the status tabs, `(organizationId, lastMessageAt DESC)`
for "all", `(organizationId, assignedToUserId, status)` for "assigned to me", `(organizationId, priority,
lastMessageAt DESC)` for the priority views and `(organizationId, customerId, lastMessageAt DESC)` for
Customer 360. `messages` and `conversation_events` use `(organizationId, conversationId, createdAt, id)`
for chronological pages and stable cursors. There is deliberately no index on `subject` (substring
search) or on every column; see [conversations](conversations.md#indexes).

`20261007081300_conversation_check_constraints` is hand-written (Prisma cannot express CHECK
constraints): non-blank subject/body, `closedAt` set exactly when RESOLVED, preview <= 200 chars,
only USER messages carry `senderUserId`, and customers cannot author internal notes.
`conversations.updatedAt` and `messages.updatedAt` have defaults and are set by the application.

## Knowledge base tables (Phase 4)

| Table                       | Notes                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge_documents`       | Tenant-owned. `status` enum (DRAFT/PUBLISHED/ARCHIVED), `contentVersion` (bumped on title/content change), `UNIQUE (id, organizationId)`.  |
| `knowledge_document_chunks` | `content`, `estimatedTokens`, `contentVersion`, **`embedding vector(768)`**. Composite FK to documents; `UNIQUE (documentId, chunkIndex)`. |
| `messages.metadata` (new)   | Nullable JSONB. AI replies store provenance (model, prompt version, sources, usage). Never prompts or secrets.                             |

Migrations: `20261007100627_knowledge_base` (Prisma-generated, plus one hand-added line
`CREATE EXTENSION IF NOT EXISTS vector;` because Prisma cannot express extensions) and
`20261007100700_knowledge_check_constraints` (hand-written CHECKs). The vector column is declared
`Unsupported("vector(768)")` in `schema.prisma`: Prisma cannot read or write it, so chunk writes and
similarity search are reviewed raw SQL, parameterized and tenant-filtered, isolated in
`src/server/repositories/knowledge-chunks.ts`. On Supabase the extension may already live in the
`extensions` schema; `IF NOT EXISTS` then does nothing and the type resolves through the role's
search_path.

### Indexing decisions

- `knowledge_documents (organizationId, status, updatedAt DESC)` and `(organizationId, updatedAt DESC)`:
  the knowledge list (with and without a status filter), newest first.
- `knowledge_document_chunks (organizationId, documentId)`: the tenant slice scanned by vector
  search, and per-document replace/delete.
- `UNIQUE (documentId, chunkIndex)`: stable ordering and one row per position.
- **No HNSW/IVFFlat index on `embedding`, on purpose.** Approximate indexes filter after searching,
  which can under-return for small tenants in a multi-tenant table. Search is an exact scan of one
  organization's chunks. See [rag.md](rag.md#why-no-hnswivfflat-index-yet) for when to revisit.
- Cosine distance (`<=>`) with L2-normalized vectors; 768 dimensions (rationale in [rag.md](rag.md)).

## AI tool approvals and audit (Phase 5)

- `ai_action_approvals`: pending/decided AI-requested changes (`toolName`, validated `input`, display
  `preview`, `riskLevel`, `status`, `expiresAt`, approver/rejecter ids, `executedAt`, `failureCode`).
  Tenant-owned; `(conversationId, organizationId)` is a composite foreign key to `conversations`.
  CHECK constraints keep the lifecycle consistent (see migration `ai_tools_check_constraints`).
- `ai_tool_audits`: one row per tool attempt (actor, tool, risk, approval id, outcome, error code).
  No payloads. See [ai-tools.md](ai-tools.md).
