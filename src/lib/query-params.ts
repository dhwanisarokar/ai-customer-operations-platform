import { z } from "zod";

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 25;

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
});
export type Pagination = z.output<typeof paginationSchema>;

/** Comma separated query value ("a,b") validated item by item (max 20 items). */
export function csv<T extends string>(item: z.ZodType<T, T>) {
  return z
    .string()
    .transform((value) =>
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item).max(20));
}

export const booleanParam = z.enum(["true", "false"]).transform((value) => value === "true");
