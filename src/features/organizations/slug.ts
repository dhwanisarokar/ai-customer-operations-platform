import { randomBytes } from "node:crypto";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MIN = 2;
export const SLUG_MAX = 48;

/** Lowercases, strips diacritics, collapses non-alphanumerics to single hyphens. */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "");
  return slug.length >= SLUG_MIN ? slug : "org";
}

/** Appends a short random suffix, keeping the result within the slug length limit. */
export function withRandomSuffix(slug: string): string {
  const suffix = randomBytes(2).toString("hex");
  return `${slug.slice(0, SLUG_MAX - suffix.length - 1).replace(/-+$/g, "")}-${suffix}`;
}
