# 002 — Prisma as the ORM

## Problem

Need type-safe database access with first-class migrations.

## Options considered

Prisma, Drizzle.

## Decision

Prisma 7 with the `prisma-client` generator and the `@prisma/adapter-pg` driver adapter.

## Reason

Mature migration workflow, strong generated types, good ergonomics for a modular monolith. Raw SQL
(`$queryRaw`) remains available for pgvector queries.

## Tradeoffs

Generated client must be produced (`postinstall`, gitignored output). Vector columns need raw SQL or
`Unsupported` types. Drizzle would be closer to SQL; revisit only if this becomes a real constraint.
