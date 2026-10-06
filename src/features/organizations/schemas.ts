import { z } from "zod";
import { SLUG_MAX, SLUG_MIN, SLUG_PATTERN } from "./slug";

export const organizationIdSchema = z.uuid();

export const createOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  slug: z
    .string()
    .min(SLUG_MIN)
    .max(SLUG_MAX)
    .regex(SLUG_PATTERN, "Use lowercase letters, numbers and single hyphens")
    .optional(),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

/** OWNER is intentionally absent: ownership changes only through the transfer endpoint. */
export const assignableRoleSchema = z.enum(["ADMIN", "MEMBER"]);

export const addMemberSchema = z.object({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: assignableRoleSchema.default("MEMBER"),
});
export type AddMemberInput = z.infer<typeof addMemberSchema>;

export const changeRoleSchema = z.object({ role: assignableRoleSchema });
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const transferOwnershipSchema = z.object({ userId: z.uuid() });
export type TransferOwnershipInput = z.infer<typeof transferOwnershipSchema>;

export const setActiveOrganizationSchema = z.object({ organizationId: z.uuid() });
