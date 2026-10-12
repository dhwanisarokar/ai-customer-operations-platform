# 014 - Customer portal: Clerk identity + explicit invitation-based customer link

Status: accepted

## Context

Phase 8 adds an authenticated customer portal. The platform already has staff (Clerk + memberships) and
anonymous widget visitors (session tokens). Customer records are organization-scoped, emails are unique per
organization (not globally), and web chat identity resolution links conversations to customers by an
**unverified** email. We need a third context, an authenticated customer, without letting anyone take over a
customer record.

## Decision

- **Reuse Clerk** as the identity provider (same instance, same just-in-time `users` provisioning). A second
  provider would duplicate sessions, middleware and provisioning for no concrete benefit.
- **Identity is not authorization.** Access comes only from `customer_portal_accounts(organizationId, userId,
customerId)`, created by redeeming a **staff-issued, single-use, expiring invitation** for that customer. The
  redemption additionally requires the identity's **verified** email (from Clerk, on the server) to equal the
  customer's email. Email alone never grants access; the token alone never grants access.
- **Database integrity:** `UNIQUE(organizationId, userId)`, `UNIQUE(organizationId, customerId)` and a composite
  FK to `customers(id, organizationId)`; the invitation is consumed by one conditional UPDATE; only the token
  hash is stored.
- **Tenant selection by slug:** `/portal/{organizations.slug}` (public, already unique). It only selects the
  organization; unknown and disabled portals are the same 404; `organizationId` is never client-supplied. A new
  additive `portal_settings` table holds the per-organization on/off switch (default off).
- **No parallel domain:** portal conversations are normal conversations (`ConversationChannel.PORTAL`) written
  through the shared `persistMessage` with a `portal` actor, so idempotency, status rules, events, automations,
  realtime, the inbox and the customer-facing AI (handling mode, atomic claim) apply unchanged. The portal shows
  only PORTAL conversations of the linked customer.
- **Narrow capabilities:** customers can send messages, request a person, read published help articles and edit
  first name, last name and phone. They cannot touch email, notes, tags, status, priority, assignment or handling
  mode (strict schemas; no routes).
- Permission `manage_portal` (ADMIN/OWNER) for enabling the portal, inviting and revoking.

## Alternatives considered

- **Link by verified email automatically:** the exact account-takeover risk the phase warns about (anyone able
  to create a Clerk account with a victim's address, or a staff typo in a customer's email, would expose the
  record). Rejected; email is only the second factor.
- **A separate customer auth provider / password table:** more surface, no benefit. Rejected.
- **Show all conversations of the customer record (including web chat / staff-created):** web chat conversations
  are attached by unverified email, staff-created ones may carry internal subjects. Rejected.
- **A client-supplied organization id:** never trusted; the slug selects, the link authorizes.

## Consequences

- One additive migration (`customer_portal`): enum value `PORTAL`, tables `portal_settings`,
  `customer_portal_accounts`, `portal_invites`, a CHECK on invitation expiry.
- Customers need an email on their record and a staff invitation; delivery of the link is manual for now.
- The realtime layer gained one channel kind (`portal:{org}:{customer}`) with its own authorization function.
