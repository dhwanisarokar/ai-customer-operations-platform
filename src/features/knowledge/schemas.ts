import { z } from "zod";
import { collapseWhitespace, emptyToNull } from "@/features/customers/normalize";
import { csv, paginationSchema } from "@/lib/query-params";

export const KNOWLEDGE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];

export const MAX_TITLE_LENGTH = 200;
export const MAX_DESCRIPTION_LENGTH = 500;
/** About 36 chunks, so indexing is a single embedding request. */
export const MAX_CONTENT_LENGTH = 100_000;

const titleSchema = z
  .string()
  .transform(collapseWhitespace)
  .pipe(
    z
      .string()
      .min(1, "Title is required")
      .max(MAX_TITLE_LENGTH, `Title must be at most ${MAX_TITLE_LENGTH} characters`),
  );

const descriptionSchema = z
  .string()
  .max(MAX_DESCRIPTION_LENGTH, `Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`)
  .nullish()
  .transform((value) => emptyToNull(value));

const contentSchema = z
  .string()
  .refine((value) => value.trim().length > 0, "Content is required")
  .refine(
    (value) => value.length <= MAX_CONTENT_LENGTH,
    `Content must be at most ${MAX_CONTENT_LENGTH} characters`,
  );

// .strict(): organizationId, status, createdBy and other server-owned fields are rejected.
export const createDocumentSchema = z
  .object({ title: titleSchema, description: descriptionSchema, content: contentSchema })
  .strict();
export type CreateDocumentInput = z.output<typeof createDocumentSchema>;

export const updateDocumentSchema = z
  .object({
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    content: contentSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: "Provide at least one field" });
export type UpdateDocumentInput = z.output<typeof updateDocumentSchema>;

export const KNOWLEDGE_SORT_FIELDS = ["updatedAt", "createdAt", "title"] as const;

export const listDocumentsQuerySchema = paginationSchema.extend({
  q: z.string().trim().max(100).optional(),
  status: csv(z.enum(KNOWLEDGE_STATUSES)).optional(),
  sort: z.enum(KNOWLEDGE_SORT_FIELDS).default("updatedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export type ListDocumentsQuery = z.output<typeof listDocumentsQuerySchema>;
