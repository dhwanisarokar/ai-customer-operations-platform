import { z } from "zod";
import {
  booleanParam,
  csv,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationSchema,
  type Pagination,
} from "@/lib/query-params";
import { collapseWhitespace, emptyToNull, normalizeEmail, normalizePhone } from "./normalize";

export const CUSTOMER_STATUSES = ["ACTIVE", "INACTIVE", "ARCHIVED"] as const;
/** Statuses a client may set. ARCHIVED is reached only through the archive endpoint. */
export const SETTABLE_STATUSES = ["ACTIVE", "INACTIVE"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .max(max, `Must be at most ${max} characters`)
    .nullish()
    .transform((value) => emptyToNull(value));

const emailField = z.string().max(254).pipe(z.email("Enter a valid email address"));

const phoneField = z
  .string()
  .max(40, "Phone number is too long")
  .transform((value, ctx) => {
    const phone = normalizePhone(value);
    if (!phone) {
      ctx.addIssue({ code: "custom", message: "Enter a valid phone number (5-15 digits)" });
      return z.NEVER;
    }
    return phone;
  });

/** Optional email/phone: blank input means "no value" (stored as NULL). */
const optionalEmail = z
  .string()
  .nullish()
  .transform((value) => emptyToNull(value))
  .pipe(emailField.transform(normalizeEmail).nullable());

const optionalPhone = z
  .string()
  .nullish()
  .transform((value) => emptyToNull(value))
  .pipe(phoneField.nullable());

const requiredName = z
  .string()
  .transform(collapseWhitespace)
  .pipe(z.string().min(1, "First name is required").max(100, "Must be at most 100 characters"));

const fields = {
  firstName: requiredName,
  lastName: optionalText(100),
  email: optionalEmail,
  phone: optionalPhone,
  company: optionalText(150),
  jobTitle: optionalText(150),
  source: optionalText(50),
  externalId: optionalText(100),
  status: z.enum(SETTABLE_STATUSES),
  metadata: z.record(z.string(), z.unknown()).nullish(),
};

// .strict(): unknown keys (organizationId, id, createdAt, ...) are rejected with 400 rather than
// silently ignored, so tampering attempts are visible instead of quietly "working".
export const createCustomerSchema = z
  .object({ ...fields, status: fields.status.default("ACTIVE") })
  .strict();
export type CreateCustomerInput = z.output<typeof createCustomerSchema>;

export const updateCustomerSchema = z
  .object({
    firstName: fields.firstName.optional(),
    lastName: fields.lastName.optional(),
    email: fields.email.optional(),
    phone: fields.phone.optional(),
    company: fields.company.optional(),
    jobTitle: fields.jobTitle.optional(),
    source: fields.source.optional(),
    externalId: fields.externalId.optional(),
    status: fields.status.optional(),
    metadata: fields.metadata.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field" });
export type UpdateCustomerInput = z.output<typeof updateCustomerSchema>;

// ---- list / pagination ----------------------------------------------------------------------

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, paginationSchema, type Pagination };

export const CUSTOMER_SORT_FIELDS = ["createdAt", "updatedAt", "name", "lastActivityAt"] as const;

export const listCustomersQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(CUSTOMER_STATUSES)).optional(),
  tagIds: csv(z.uuid()).optional(),
  company: z.string().trim().max(150).optional(),
  source: z.string().trim().max(50).optional(),
  createdFrom: z.iso.datetime({ offset: true }).optional(),
  createdTo: z.iso.datetime({ offset: true }).optional(),
  includeArchived: booleanParam.optional(),
  sort: z.enum(CUSTOMER_SORT_FIELDS).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type ListCustomersQuery = z.output<typeof listCustomersQuerySchema>;

// ---- tags, notes ------------------------------------------------------------------------------

export const tagNameSchema = z
  .string()
  .transform(collapseWhitespace)
  .pipe(z.string().min(1, "Tag name is required").max(40, "Tag name is too long"));

export const createTagSchema = z.object({ name: tagNameSchema }).strict();
export const updateTagSchema = z.object({ name: tagNameSchema }).strict();

/** Assign an existing tag by id, or find-or-create one by name. */
export const assignTagSchema = z.union([
  z.object({ tagId: z.uuid() }).strict(),
  z.object({ name: tagNameSchema }).strict(),
]);
export type AssignTagInput = z.output<typeof assignTagSchema>;

export const createNoteSchema = z
  .object({
    content: z
      .string()
      .trim()
      .min(1, "Note cannot be empty")
      .max(5000, "Note is too long (max 5000 characters)"),
  })
  .strict();
