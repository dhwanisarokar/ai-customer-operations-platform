const BACKSLASH = String.fromCharCode(92);

/**
 * Prisma passes `contains` values into LIKE unescaped, so a user typing % or _ would match
 * everything. Escape the LIKE metacharacters (backslash, %, _) before using a term in `contains`.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\x5c%_]/g, (character) => BACKSLASH + character);
}

/** Whitespace-separated search terms (max 5); every term must match somewhere. */
export function searchTokens(q: string | undefined): string[] {
  return (q ?? "").split(/\s+/).filter(Boolean).slice(0, 5);
}
