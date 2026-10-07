# 005 - Composite foreign keys for tenant consistency

## Problem

ADR 003 enforces tenant isolation in the application layer. A child row (note, activity, tag link)
that carries its own `organizationId` plus a `customerId` could still, through a bug, reference a
customer of a different organization, because plain foreign keys only check that the customer exists.

## Options considered

1. Application checks only (every service verifies both rows belong to the caller's organization).
2. Row-level security policies on every table.
3. Composite foreign keys: parents expose `UNIQUE (id, organizationId)`; children reference
   `(customerId, organizationId)` / `(tagId, organizationId)`.

## Decision

Option 3 for customer-owned tables (`customer_tags`, `customer_notes`, `customer_activities`),
in addition to the application checks. RLS stays a possible later addition.

## Reason

It makes the invariant "a child and its parent are in the same organization" a database guarantee
with no runtime cost beyond one extra unique index per parent, works with Prisma's schema language,
and is cheap to test (`customer-constraints.test.ts` attempts cross-tenant inserts directly).

## Tradeoffs

Extra `UNIQUE (id, organizationId)` indexes and wider foreign keys; every new tenant-owned child
table must follow the pattern. It does not stop a service from reading another tenant's rows, so
repositories still take an explicit `organizationId` (ADR 003).
