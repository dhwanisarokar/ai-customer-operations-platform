import { transaction } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import type { AddMemberInput, ChangeRoleInput } from "@/features/organizations/schemas";
import { createLogger } from "@/lib/logger";
import type { OrganizationContext } from "@/server/auth/context";
import { canAssignRole, outranks } from "@/server/auth/permissions";
import { Role } from "@/generated/prisma/enums";
import { ConflictError, ForbiddenError, NotFoundError } from "@/server/errors";
import { conversationEventsRepository } from "@/server/repositories/conversation-events";
import { conversationsRepository } from "@/server/repositories/conversations";
import { membershipsRepository } from "@/server/repositories/memberships";
import { usersRepository } from "@/server/repositories/users";

const log = createLogger("memberships");

export async function listMembers(ctx: OrganizationContext) {
  ctx.require("view_members");
  return membershipsRepository.listMembers(ctx.organization.id);
}

/**
 * Adds an already-registered user. Email invitations for unregistered users are a later phase;
 * until then members must sign up first.
 */
export async function addMember(ctx: OrganizationContext, input: AddMemberInput) {
  ctx.require("manage_members");
  if (!canAssignRole(ctx.membership.role, input.role)) throw new ForbiddenError();

  const user = await usersRepository.findByEmail(input.email);
  if (!user) throw new NotFoundError("No registered user with that email address");

  try {
    await membershipsRepository.create(ctx.organization.id, user.id, input.role);
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError("User is already a member");
    throw error;
  }
  log.info(
    {
      organizationId: ctx.organization.id,
      actorId: ctx.user.id,
      targetId: user.id,
      role: input.role,
    },
    "member added",
  );
  return requireMember(ctx.organization.id, user.id);
}

export async function changeMemberRole(
  ctx: OrganizationContext,
  targetUserId: string,
  input: ChangeRoleInput,
) {
  ctx.require("manage_members");
  const target = await requireMember(ctx.organization.id, targetUserId);

  // Rank checks stop admins from touching owners/other admins and from granting admin.
  if (targetUserId === ctx.user.id) throw new ForbiddenError("You cannot change your own role");
  if (!outranks(ctx.membership.role, target.role)) throw new ForbiddenError();
  if (!canAssignRole(ctx.membership.role, input.role)) throw new ForbiddenError();

  await membershipsRepository.updateRole(ctx.organization.id, targetUserId, input.role);
  log.info(
    {
      organizationId: ctx.organization.id,
      actorId: ctx.user.id,
      targetId: targetUserId,
      role: input.role,
    },
    "member role changed",
  );
  return requireMember(ctx.organization.id, targetUserId);
}

/** Removes a member, or lets a non-owner leave. The sole owner can never be removed. */
export async function removeMember(ctx: OrganizationContext, targetUserId: string) {
  const target = await requireMember(ctx.organization.id, targetUserId);
  const isSelf = targetUserId === ctx.user.id;

  if (target.role === Role.OWNER) {
    throw new ForbiddenError("Transfer ownership before removing the owner");
  }
  if (!isSelf) {
    ctx.require("manage_members");
    if (!outranks(ctx.membership.role, target.role)) throw new ForbiddenError();
  }

  // Conversations assigned to the leaving member are unassigned first: the assignee foreign key
  // (conversations -> memberships) would otherwise block the delete. Same transaction, so a failure
  // leaves both the membership and the assignments untouched.
  await transaction(async (tx) => {
    const unassigned = await conversationsRepository.unassignAllForUser(
      ctx.organization.id,
      targetUserId,
      tx,
    );
    await conversationEventsRepository.recordMany(
      ctx.organization.id,
      unassigned,
      {
        type: "UNASSIGNED",
        metadata: { from: targetUserId, reason: "member_removed" },
        actorType: "USER",
        actorId: ctx.user.id,
      },
      tx,
    );
    await membershipsRepository.remove(ctx.organization.id, targetUserId, tx);
  });
  log.info(
    { organizationId: ctx.organization.id, actorId: ctx.user.id, targetId: targetUserId },
    "member removed",
  );
}

export async function transferOwnership(ctx: OrganizationContext, targetUserId: string) {
  ctx.require("transfer_ownership");
  if (targetUserId === ctx.user.id) throw new ForbiddenError("You already own this organization");
  await requireMember(ctx.organization.id, targetUserId);

  const ok = await membershipsRepository.transferOwnership(
    ctx.organization.id,
    ctx.user.id,
    targetUserId,
  );
  if (!ok) throw new ConflictError("Ownership changed concurrently; please retry");
  log.info(
    { organizationId: ctx.organization.id, fromId: ctx.user.id, toId: targetUserId },
    "ownership transferred",
  );
}

async function requireMember(organizationId: string, userId: string) {
  const member = await membershipsRepository.findMember(organizationId, userId);
  if (!member) throw new NotFoundError("Member not found");
  return member;
}
