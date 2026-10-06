# 003 — Tenant isolation strategy

## Problem

Organization A must never access Organization B's data; enforcement must be server-side.

## Options considered

1. Shared schema, `organizationId` on every table, enforced in the service/repository layer
2. Option 1 plus Postgres row-level security (RLS)
3. Schema- or database-per-tenant

## Decision

Start with option 1: shared schema, with the organization id derived from the authenticated session
(never from client input) and required by every repository function. Evaluate adding RLS as
defense-in-depth once the first tenant-scoped tables exist.

## Reason

Simplest model that scales to many tenants with a single migration path. Required-by-signature
org scoping makes omissions hard to write and easy to test.

## Tradeoffs

Isolation depends on application discipline until RLS is added; mitigated by cross-tenant tests for
every tenant-owned resource.
