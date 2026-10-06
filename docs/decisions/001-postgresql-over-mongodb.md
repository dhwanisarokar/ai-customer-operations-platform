# 001 — PostgreSQL over MongoDB

## Problem

Need a primary datastore for relational, multi-tenant data (orgs, customers, conversations, workflow
runs, billing) that also supports vector search for RAG.

## Options considered

1. PostgreSQL (+ pgvector)
2. MongoDB (+ Atlas Vector Search)
3. PostgreSQL + a dedicated vector database

## Decision

PostgreSQL with pgvector.

## Reason

The domain is strongly relational (foreign keys, unique constraints, transactions). Tenant isolation
can be enforced with FK + indexed `organizationId` (and optionally row-level security later).
pgvector keeps embeddings next to their source rows, avoiding a second system to operate.

## Tradeoffs

Less flexible for schemaless payloads (mitigated with `jsonb`). pgvector may need re-evaluation at very
large embedding volumes.
