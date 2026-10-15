import { z } from "zod";
import { MAX_LOCAL_PART_LENGTH } from "@/server/email/address";

/** Email settings input. Strict: organizationId, status, supportAddress... are rejected, never trusted. */

export const MAX_FROM_NAME_LENGTH = 80;

export const emailAddressInputSchema = z
  .object({
    localPart: z.string().trim().min(1, "Choose an address name").max(MAX_LOCAL_PART_LENGTH),
    fromName: z
      .string()
      .trim()
      .min(1, "Enter the name replies are sent from")
      .max(MAX_FROM_NAME_LENGTH),
  })
  .strict();
export type EmailAddressInput = z.output<typeof emailAddressInputSchema>;

export const emailEnabledSchema = z.object({ enabled: z.boolean() }).strict();
