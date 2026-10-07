# Knowledge base

A tenant-scoped library of articles (refund policy, shipping, FAQs) that the AI support agent may
use to answer customers. Only **published** documents are searchable. How retrieval works is in
[rag.md](rag.md); how the agent uses it is in [ai-agent.md](ai-agent.md).

```text
Organization
   └── KnowledgeDocument ──── 1..n ──── KnowledgeDocumentChunk (text + vector(768))
         DRAFT | PUBLISHED | ARCHIVED
```

Code map: `src/features/knowledge` (chunking, schemas, list params, UI),
`src/server/services/knowledge*.ts` (lifecycle, indexing, retrieval),
`src/server/repositories/knowledge-*.ts` (queries, the only raw SQL), `src/app/api/knowledge`
(thin routes), `src/app/dashboard/knowledge` (pages).

## Data model

| Model                    | Fields of note                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `KnowledgeDocument`      | `title`, `description`, `content`, `status`, `contentVersion`, `publishedAt`, `createdBy`/`updatedBy` (users, `SET NULL`). |
| `KnowledgeDocumentChunk` | `chunkIndex`, `content`, `estimatedTokens`, `contentVersion`, `embedding vector(768)`.                                     |

`contentVersion` starts at 1 and increments whenever the title or content change. Each chunk records
the version it was built from, and retrieval only returns chunks whose version equals their
document's current version, so a stale vector can never be retrieved even if clean-up were missed.

Tenant integrity: chunks reference `(documentId, organizationId)` with a composite foreign key
(the pattern from [ADR 005](decisions/005-composite-foreign-keys-for-tenant-consistency.md)), so a
chunk cannot belong to a different organization than its document. Hand-written CHECK constraints
(non-blank title/chunk text, positive version/token counts, published documents have `publishedAt`)
are in `20261007100700_knowledge_check_constraints`.

## Lifecycle

```text
DRAFT --publish--> PUBLISHED --unpublish--> DRAFT
any non-archived --archive--> ARCHIVED --unpublish ("restore")--> DRAFT
delete: permanent, chunks cascade
```

| Action                  | Effect on embeddings                                                        | Permission                    |
| ----------------------- | --------------------------------------------------------------------------- | ----------------------------- |
| create / edit draft     | none (drafts are never embedded)                                            | `edit_knowledge` (any member) |
| publish                 | chunk + embed, then flip status and store chunks in one transaction         | `publish_knowledge` (ADMIN+)  |
| edit published/archived | re-chunk + re-embed, then update content and swap chunks in one transaction | `publish_knowledge`           |
| unpublish / archive     | chunks deleted in the same transaction as the status change                 | `publish_knowledge`           |
| delete                  | document and chunks removed                                                 | `publish_knowledge`           |
| view / list             | n/a                                                                         | `view_knowledge` (any member) |

Why the split: members can write drafts, but anything that changes what the AI tells customers
needs an ADMIN. Viewing is open to every member.

## Failure handling: external calls are not transactional

Embedding calls Gemini, which cannot join a PostgreSQL transaction. The design is therefore
**embed first, write second**:

1. Read the document (remember `contentVersion` = v).
2. Chunk and embed (external; nothing written yet).
3. In ONE transaction: `UPDATE ... WHERE contentVersion = v` (optimistic lock), then delete the old
   chunks and insert the new ones.

Consequences:

- If embedding fails (rate limit, timeout, invalid vectors) the request fails with a safe error and
  **nothing changed**: a failed publish leaves a clean draft; a failed edit keeps the previous
  content and its matching chunks. There is never "published without vectors" or "new text with old
  vectors".
- If the document was changed by someone else in the meantime, step 3 matches zero rows and the
  request returns `409` (reload and retry); the other edit's content and chunks stay consistent.
- If the database transaction fails, it rolls back as a whole.

The cost is that saving a published document takes as long as embedding it (typically 1-2 seconds
for an article), and the UI says so.

## Chunking

Deterministic and dependency-free (`src/features/knowledge/chunking.ts`):

- Normalize line endings and blank lines; split into paragraphs.
- Pack paragraphs greedily up to **2,800 characters** (about 700 tokens); a paragraph that is too
  long is split at sentence boundaries, then at word boundaries.
- Each later chunk starts with the last **300 characters** (about 75 tokens, snapped to a word
  boundary) of the previous chunk, so a sentence cut at a boundary remains retrievable.
- Chunk indexes are stable (`0..n-1`); the same input always yields the same chunks.
- The document **title is embedded with every chunk** (as a title hint), so "Refund policy" context
  is part of each passage's vector. Consequently a title change re-indexes; a description change
  does not (the description is not embedded).

Sizes are in characters because no tokenizer is bundled. `estimatedTokens` is `ceil(chars / 4)` and
is an estimate, not a tokenizer result. Documents are limited to 100,000 characters (about 36
chunks, one embedding request).

## API

See [api.md](api.md#knowledge-base). List supports `page`, `pageSize`, `q` (title, description or
content), `status` and `sort` (`updatedAt`, `createdAt`, `title`). Responses never contain
embeddings.

## Known limitations

- Plain text only (no files, URLs or rich text); no version history of content.
- Indexing runs inside the request (no background worker yet), so very large documents are limited.
- Search over the list uses substring matching, not the vector index.
