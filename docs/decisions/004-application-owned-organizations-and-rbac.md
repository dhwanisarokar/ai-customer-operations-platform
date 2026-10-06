# 004 - Application-owned organizations and RBAC (Clerk for identity only)

## Problem

We need authentication plus multi-tenant organizations and roles. Clerk offers Organizations,
roles and invitations, but our data model, tenant isolation, audit logs and (later) billing all hang
off organizations in our own database.

## Options considered

1. Clerk Organizations as the source of truth for organizations, members and roles.
2. Clerk for identity only; organizations, memberships and roles live in our PostgreSQL database.
3. Clerk Organizations as source of truth, mirrored into our database via webhooks.

## Decision

Option 2. Clerk answers "who is this user?". Our database answers "which organizations, which
role, which permissions?".

## Reason

- Tenant isolation needs foreign keys from every tenant table to `organizations`; a mirrored copy
  (option 3) adds webhook ordering/idempotency problems to the most security-critical data.
- Authorization checks become one indexed query we can unit/integration test against a real
  database, with no network call to a third party on the request path.
- Roles and permissions can evolve (custom roles, per-resource permissions) without being limited
  by a vendor's role model.
- Reduces vendor lock-in: swapping Clerk affects only `src/server/auth/identity.ts` and the
  `authProviderId` column.

## Tradeoffs

- We build membership management ourselves, and **invitations** (email flow for users who have not
  signed up) are deferred. Until then members can only be added by email if they already have an
  account.
- Profile changes in Clerk are not synced yet (planned webhook).
- Clerk's prebuilt organization UI is unavailable; we build the small UI we need.
