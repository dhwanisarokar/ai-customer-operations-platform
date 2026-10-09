import { z } from "zod";

/** Public widget input. Strict everywhere: organizationId, customerId, sender... are rejected. */

export const MAX_WIDGET_MESSAGE_LENGTH = 2000;
export const MAX_PUBLIC_BODY_BYTES = 16 * 1024;

const messageBody = z
  .string()
  .trim()
  .min(1, "Message cannot be empty")
  .max(
    MAX_WIDGET_MESSAGE_LENGTH,
    `Message is too long (max ${MAX_WIDGET_MESSAGE_LENGTH} characters)`,
  );

/** A website origin such as https://example.com (no path), normalized. */
const originSchema = z
  .string()
  .trim()
  .max(200)
  .transform((value, ctx) => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("protocol");
      return url.origin;
    } catch {
      ctx.addIssue({ code: "custom", message: "Enter a website like https://example.com" });
      return z.NEVER;
    }
  });

/** Organization admin settings (PUT /api/widget-settings). */
export const widgetSettingsInputSchema = z
  .object({
    enabled: z.boolean(),
    displayName: z.string().trim().min(1, "Name is required").max(60),
    welcomeMessage: z.string().trim().min(1, "Welcome message is required").max(500),
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Use a color like #0f766e")
      .nullish()
      .transform((value) => value ?? null),
    // Automatic, read-only AI answers to visitors. Omitted = unchanged.
    aiRepliesEnabled: z.boolean().optional(),
    allowedOrigins: z
      .array(originSchema)
      .max(10)
      .transform((origins) => [...new Set(origins)]),
  })
  .strict();
export type WidgetSettingsInput = z.output<typeof widgetSettingsInputSchema>;

/** POST /api/widget/session. The visitor token travels in the Authorization header, not here. */
export const widgetSessionRequestSchema = z
  .object({
    key: z.string().min(16).max(80),
    /** The website embedding the widget, as reported by the browser (a policy hint, not auth). */
    embedOrigin: z.string().max(200).optional(),
  })
  .strict();

const clientMessageId = z.uuid();

export const widgetCreateConversationSchema = z
  .object({ body: messageBody, clientMessageId })
  .strict();

export const widgetSendMessageSchema = z.object({ body: messageBody, clientMessageId }).strict();

export const widgetIdentitySchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    email: z
      .string()
      .trim()
      .max(254)
      .pipe(z.email("Enter a valid email address"))
      .transform((value) => value.toLowerCase())
      .optional(),
  })
  .strict()
  .refine((value) => value.name || value.email, { message: "Provide a name or an email" });
export type WidgetIdentityInput = z.output<typeof widgetIdentitySchema>;
