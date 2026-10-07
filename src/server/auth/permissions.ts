import { Role } from "@/generated/prisma/enums";

export type { Role };

/** Capabilities checked by server code. Add new ones here and map them to roles below. */
export const PERMISSIONS = [
  "view_organization",
  "manage_organization",
  "view_members",
  "manage_members",
  "transfer_ownership",
  "view_customers",
  "create_customers",
  "update_customers",
  "archive_customers",
  "add_customer_notes",
  "tag_customers",
  "manage_tags",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

// Members do day-to-day customer work. Destructive or organization-wide actions (archiving
// customers, renaming/deleting shared tags) need an ADMIN.
const MEMBER_PERMISSIONS: readonly Permission[] = [
  "view_organization",
  "view_members",
  "view_customers",
  "create_customers",
  "update_customers",
  "add_customer_notes",
  "tag_customers",
];
const ADMIN_PERMISSIONS: readonly Permission[] = [
  ...MEMBER_PERMISSIONS,
  "manage_members",
  "archive_customers",
  "manage_tags",
];
const OWNER_PERMISSIONS: readonly Permission[] = [
  ...ADMIN_PERMISSIONS,
  "manage_organization",
  "transfer_ownership",
];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  [Role.MEMBER]: new Set(MEMBER_PERMISSIONS),
  [Role.ADMIN]: new Set(ADMIN_PERMISSIONS),
  [Role.OWNER]: new Set(OWNER_PERMISSIONS),
};

const ROLE_RANK: Record<Role, number> = {
  [Role.MEMBER]: 1,
  [Role.ADMIN]: 2,
  [Role.OWNER]: 3,
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Actors may only act on members who rank strictly below them. */
export function outranks(actor: Role, target: Role): boolean {
  return ROLE_RANK[actor] > ROLE_RANK[target];
}

/**
 * Roles an actor may grant. OWNER is never assignable directly (see ownership transfer), and an
 * actor can only grant roles strictly below their own, so admins cannot mint other admins.
 */
export function canAssignRole(actor: Role, newRole: Role): boolean {
  return newRole !== Role.OWNER && outranks(actor, newRole);
}
