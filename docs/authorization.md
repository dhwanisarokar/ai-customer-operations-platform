# Authorization

## Model

```text
User ──< Membership >── Organization
             │
             └─ role: OWNER | ADMIN | MEMBER
```

- An **organization** is a tenant. A **membership** links one user to one organization with one role.
- `(userId, organizationId)` is unique (database constraint). A user's role is per organization.
- Every organization has exactly one `OWNER` at a time (enforced by the service and the atomic
  transfer; the owner cannot leave or be removed).

## Permissions

Defined in `src/server/auth/permissions.ts`. Add a permission to `PERMISSIONS` and map it to roles.

| Permission            | OWNER | ADMIN | MEMBER |
| --------------------- | :---: | :---: | :----: |
| `view_organization`   |   x   |   x   |   x    |
| `view_members`        |   x   |   x   |   x    |
| `manage_members`      |   x   |   x   |        |
| `manage_organization` |   x   |       |        |
| `transfer_ownership`  |   x   |       |        |

### Hierarchy rules for member management

Permissions alone are not enough; actors may only act on people **below** them:

- Remove / change the role of a member only if you strictly outrank them (OWNER > ADMIN > MEMBER).
- Grant only roles strictly below your own, so an ADMIN can add MEMBERs but cannot create ADMINs.
- `OWNER` is never assignable. Ownership moves only through `POST .../ownership-transfer`, which
  atomically promotes the target and demotes the old owner to ADMIN.
- Anyone except the owner may remove themselves (leave).

## Tenant isolation

The organization id never authorizes anything by itself. Every tenant-scoped request goes through:

```ts
const ctx = await requireOrganizationContext(organizationId);
ctx.require("manage_members"); // throws 403
```

1. `requireUser()` resolves the authenticated user (401 if signed out).
2. The membership of _that user_ in _that organization_ is loaded from the database.
3. No membership means `404 Not Found`, identical for foreign and nonexistent organizations, so
   existence is not leaked. Malformed ids are also 404.
4. The context exposes `organization`, `membership.role`, `can()` and `require()`.

Repositories take an explicit `organizationId` parameter that services fill from the verified
context, never from request input. Future tenant-owned tables must follow the same rule (see
[ADR 003](decisions/003-tenant-isolation.md)) and ship with a cross-tenant test.

## Where the rules are tested

- `src/server/auth/permissions.test.ts`: role/permission matrix and hierarchy (unit).
- `tests/integration/tenant-isolation.test.ts`: user A cannot reach organization B on any endpoint.
- `tests/integration/members.test.ts`: MEMBER/ADMIN/OWNER behaviour, duplicate membership, ownership
  transfer including a concurrent race.
- `tests/integration/constraints.test.ts`: database-level constraints.
