# 007 - Gemini + PostgreSQL/pgvector for RAG

## Problem

The support agent must answer from each organization's own knowledge, safely and without a large
new infrastructure footprint, while keeping the model/provider replaceable.

## Options considered

Vector store:

1. PostgreSQL with the `pgvector` extension (already our primary database, available on Supabase).
2. A dedicated vector database (Pinecone, Qdrant, Weaviate, Chroma).

Model provider:

1. Gemini via the official `@google/genai` SDK (generation, structured output, embeddings).
2. Other hosted LLMs behind the same interface later.

## Decision

- Store embeddings in PostgreSQL (`vector(768)`) and search with pgvector cosine distance, filtered
  to one organization and to published documents, in SQL.
- Use Gemini (`gemini-embedding-2` for embeddings, a Gemini Flash model for generation) behind an
  `AIProvider` interface; application code never imports the SDK.
- No ANN index yet; exact search per tenant.

## Reason

- **Tenant isolation stays in one place.** Chunks live next to their documents with the same
  composite foreign keys and the same `organizationId` filters as every other table. A separate
  vector service would need its own tenant model, sync and deletion logic, and a new failure mode
  (database and vector store disagreeing).
- **Transactional consistency where it matters.** Replacing a document's chunks and changing its
  content/status is one PostgreSQL transaction, so retrieval never sees half-updated state.
- **Operational simplicity.** No new service to run, secure or pay for; backups and migrations
  already cover it. Per-tenant corpora (hundreds of chunks) are tiny for pgvector.
- **Gemini** provides embeddings with selectable output size, structured JSON output (so replies are
  validated rather than parsed from prose) and reported token usage, behind a single key. The
  interface keeps switching provider a matter of one new adapter.

## Tradeoffs

- pgvector competes with transactional load on the same database; if retrieval becomes heavy, move
  it to a read replica or reconsider (the repository module is the only raw-SQL seam).
- Exact search scales linearly with a tenant's chunks. Approximate indexes interact badly with
  tenant filters (they can under-return), so adding one requires measurement first
  ([rag.md](../rag.md)).
- Changing the embedding model or dimension requires a migration and re-embedding all chunks.
- External API calls cannot join database transactions, so writes follow "embed first, then
  transact" with an optimistic version check ([knowledge-base.md](../knowledge-base.md)).
- `gemini-embedding-2` is multimodal and merges a plain string array into one embedding; the
  provider sends one content object per text and verifies the count.
- The relevance threshold is an initial value from a small sample and needs tuning with real data.
