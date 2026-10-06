# Authentication

## Responsibilities

| Concern                                              | Owner                   |
| ---------------------------------------------------- | ----------------------- |
| Sign-up, sign-in, sign-out, sessions, credentials    | **Clerk**               |
| Who is calling (`authProviderId`)                    | Clerk, read server-side |
| Local user record, organizations, memberships, roles | **Application / DB**    |
| What the caller may do                               | **Application**         |

We store no passwords or tokens. Clerk is _identity only_: we deliberately do not use Clerk
Organizations (see [ADR 004](decisions/004-application-owned-organizations-and-rbac.md)).

## Request flow

```text
Browser ──session cookie──▶ src/proxy.ts (clerkMiddleware)
                              │  pages: /dashboard requires a session (redirect to /sign-in)
                              │  /api/*: passes through, handlers answer 401 JSON themselves
                              ▼
                        route handler (apiHandler)
                              │ requireUser()  ── getIdentity() ──▶ Clerk auth()
                              │                  getOrCreateUser() ─▶ users table
                              │ requireOrganizationContext(orgId) ─▶ memberships table
                              ▼
                        service (checks permissions, runs org-scoped queries)
```

- `src/server/auth/identity.ts` is the only module that imports Clerk server APIs.
- `src/server/auth/context.ts` provides `requireUser()` and `requireOrganizationContext()`.
- Unauthenticated API calls get `401`; pages redirect to `/sign-in`.

## User synchronization

**Just-in-time provisioning.** The first authenticated request for a Clerk user id fetches the
profile (primary email, name) from Clerk and inserts a `users` row. Later requests are one lookup by
the unique `authProviderId`. Concurrent first requests are safe: the unique constraint makes the
loser re-read the winner's row.

Edge cases: an identity with no email gets `403`; a different identity claiming an existing email
gets `409` (emails are unique so members can be added by email).

**Not yet implemented:** propagating later profile changes (email/name edits) and deletions. The
planned mechanism is a Clerk webhook (signature-verified, idempotent) that updates/deletes the local
row. Until then local email/name reflect the values at first sign-in.

## Active organization

A user can belong to several organizations. The selected one is stored in an `httpOnly`,
`SameSite=Lax` cookie (`active_org`). It is only a **preference**: every request re-verifies
membership, and an invalid or foreign id silently falls back to the user's first membership.

## Security considerations

- Clerk secret key is server-only; only `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` reaches the browser.
- All request bodies are validated with Zod; malformed JSON is a `400`.
- Errors are returned as `{ error: { code, message, requestId } }`. Unexpected errors are logged
  with the `requestId` and returned as a generic `500`.
- 401/403 responses are logged at `warn` (no bodies, no tokens) for later security monitoring.
- State-changing endpoints require a JSON body and rely on `SameSite=Lax` session cookies; add an
  explicit CSRF/origin check before exposing cookie-authenticated endpoints cross-site.
- **Not yet implemented:** rate limiting (sign-in is protected by Clerk; our APIs are not) and
  email invitations.

## Configuration

See `.env.example`: `CLERK_SECRET_KEY`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and the sign-in/up URL
variables. Create a Clerk application and copy its development keys into `.env`.
