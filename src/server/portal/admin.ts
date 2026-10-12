import { transaction } from "@/db/client";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { ConflictError, NotFoundError } from "@/server/errors";
import { customersRepository } from "@/server/repositories/customers";
import {
  portalAccountsRepository,
  portalInvitesRepository,
  portalSettingsRepository,
} from "@/server/repositories/portal";
import { generateInviteToken, hashToken, INVITE_TTL_MS } from "./tokens";

const log = createLogger("portal");

/** Staff side of the portal. Everything needs `manage_portal` (ADMIN/OWNER). */

export async function getPortalSettings(ctx: OrganizationContext) {
  ctx.require("manage_portal");
  const existing = await portalSettingsRepository.findByOrganization(ctx.organization.id);
  return { enabled: existing?.enabled ?? false, slug: ctx.organization.slug };
}

export async function updatePortalSettings(ctx: OrganizationContext, enabled: boolean) {
  ctx.require("manage_portal");
  const organizationId = ctx.organization.id;
  const existing = await portalSettingsRepository.findByOrganization(organizationId);
  if (existing) await portalSettingsRepository.update(organizationId, enabled);
  else await portalSettingsRepository.create(organizationId, enabled);
  log.info({ organizationId, actorId: ctx.user.id, enabled }, "portal settings updated");
  return { enabled, slug: ctx.organization.slug };
}

async function requireCustomer(ctx: OrganizationContext, customerId: string) {
  const customer = await customersRepository.findById(ctx.organization.id, customerId);
  if (!customer) throw new NotFoundError("Customer not found");
  return customer;
}

/**
 * Invites a customer to the portal. Returns the one-time token (never stored in clear): the caller builds
 * the link /portal/{slug}/join?token=... Older pending invitations of the customer are invalidated.
 * A customer needs an email (it is the second factor at redemption) and must not be archived or already
 * linked.
 */
export async function createPortalInvite(ctx: OrganizationContext, customerId: string) {
  ctx.require("manage_portal");
  const organizationId = ctx.organization.id;
  const customer = await requireCustomer(ctx, customerId);
  if (customer.status === "ARCHIVED") {
    throw new ConflictError("Archived customers cannot be invited");
  }
  if (!customer.email) {
    throw new ConflictError("Add an email address to this customer before inviting them");
  }
  if (await portalAccountsRepository.findByCustomer(organizationId, customerId)) {
    throw new ConflictError("This customer already has portal access");
  }

  const token = generateInviteToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
  await transaction(async (tx) => {
    await portalInvitesRepository.expirePending(organizationId, customerId, now, tx);
    await portalInvitesRepository.create(
      {
        organizationId,
        customerId,
        tokenHash: hashToken(token),
        createdByUserId: ctx.user.id,
        expiresAt,
      },
      tx,
    );
  });
  log.info({ organizationId, customerId, actorId: ctx.user.id }, "portal invite created");
  return { token, expiresAt, joinPath: `/portal/${ctx.organization.slug}/join?token=${token}` };
}

/** Whether a customer has portal access, and any invitation waiting. No tokens are returned. */
export async function getPortalAccess(ctx: OrganizationContext, customerId: string) {
  ctx.require("manage_portal");
  const organizationId = ctx.organization.id;
  await requireCustomer(ctx, customerId);
  const [account, pending] = await Promise.all([
    portalAccountsRepository.findByCustomer(organizationId, customerId),
    portalInvitesRepository.listPending(organizationId, customerId, new Date()),
  ]);
  return {
    linked: account !== null,
    linkedAt: account?.createdAt ?? null,
    pendingInvites: pending.length,
  };
}

/** Removes the link (the customer can no longer sign in to the portal) and cancels pending invitations. */
export async function revokePortalAccess(ctx: OrganizationContext, customerId: string) {
  ctx.require("manage_portal");
  const organizationId = ctx.organization.id;
  await requireCustomer(ctx, customerId);
  const now = new Date();
  const removed = await transaction(async (tx) => {
    await portalInvitesRepository.expirePending(organizationId, customerId, now, tx);
    return portalAccountsRepository.deleteByCustomer(organizationId, customerId, tx);
  });
  log.info({ organizationId, customerId, actorId: ctx.user.id, removed }, "portal access revoked");
  return { removed: removed > 0 };
}
