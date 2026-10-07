export const PHONE_MIN_DIGITS = 5;
export const PHONE_MAX_DIGITS = 15;

/** Trims; returns null for empty/whitespace-only input so optional fields are stored as NULL. */
export function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Emails are compared case-insensitively, so they are stored lowercased and trimmed. */
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Phone numbers are stored as an optional leading "+" followed by digits only (no spaces, dashes
 * or parentheses). We do not guess country codes: "+1 (555) 010-9999" becomes "+15550109999" and
 * a number typed without "+" stays without it. Returns null when it cannot be a phone number.
 */
export function normalizePhone(value: string): string | null {
  const trimmed = value.trim();
  // Only separators we understand may appear; reject letters and other noise.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < PHONE_MIN_DIGITS || digits.length > PHONE_MAX_DIGITS) return null;
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/** Collapses internal whitespace ("  Big   Spender " becomes "Big Spender"). */
export function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeTagName(name: string): { name: string; normalizedName: string } {
  const collapsed = collapseWhitespace(name);
  return { name: collapsed, normalizedName: collapsed.toLowerCase() };
}

export function fullName(customer: { firstName: string; lastName: string | null }): string {
  return [customer.firstName, customer.lastName].filter(Boolean).join(" ");
}
