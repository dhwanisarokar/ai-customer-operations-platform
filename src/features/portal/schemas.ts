import { z } from "zod";
import { emptyToNull, normalizePhone } from "@/features/customers/normalize";

/** Customer portal input. Strict everywhere: organizationId, customerId, sender, status... are rejected. */

export const MAX_PORTAL_MESSAGE_LENGTH = 4000;
export const MAX_PORTAL_BODY_BYTES = 32 * 1024;
export const PORTAL_PAGE_SIZE_MAX = 50;

const messageBody = z
  .string()
  .trim()
  .min(1, "Message cannot be empty")
  .max(
    MAX_PORTAL_MESSAGE_LENGTH,
    `Message is too long (max ${MAX_PORTAL_MESSAGE_LENGTH} characters)`,
  );

const clientMessageId = z.uuid();

export const portalCreateConversationSchema = z
  .object({
    subject: z.string().trim().min(1, "Subject is required").max(120),
    body: messageBody,
    clientMessageId,
  })
  .strict();

export const portalSendMessageSchema = z.object({ body: messageBody, clientMessageId }).strict();

export const portalPageSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  pageSize: z.coerce.number().int().min(1).max(PORTAL_PAGE_SIZE_MAX).default(10),
});
export type PortalPage = z.output<typeof portalPageSchema>;

export const portalHelpQuerySchema = portalPageSchema.extend({
  q: z.string().trim().max(120).optional(),
});

/**
 * The ONLY profile fields a customer may change: their name and phone. Email is deliberately absent
 * (strict): changing an email would be changing who the identity is linked to, which only staff can do
 * by revoking and re-inviting. Company, tags, notes and status are staff-owned.
 */
export const portalProfileUpdateSchema = z
  .object({
    firstName: z.string().trim().min(1, "First name is required").max(100).optional(),
    lastName: z
      .string()
      .trim()
      .max(100)
      .nullish()
      .transform((value) => (value === undefined ? undefined : emptyToNull(value))),
    phone: z
      .string()
      .trim()
      .max(40)
      .nullish()
      .transform((value, ctx) => {
        if (value === undefined) return undefined;
        const trimmed = emptyToNull(value);
        if (trimmed === null) return null;
        const normalized = normalizePhone(trimmed);
        if (normalized === null) {
          ctx.addIssue({ code: "custom", message: "Enter a valid phone number" });
          return z.NEVER;
        }
        return normalized;
      }),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Nothing to update" });
export type PortalProfileUpdate = z.output<typeof portalProfileUpdateSchema>;

export const portalSettingsSchema = z.object({ enabled: z.boolean() }).strict();
