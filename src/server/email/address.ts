import { isValidEmailDomain } from "@/lib/email-domain";

/**
 * Pure helpers for email addresses and header values. Everything that ends up in a mail header or in the
 * routing table goes through here, so the rules (and their tests) live in one place.
 */

/** Names no organization may take as the local part of its support address (they have a special meaning). */
export const RESERVED_LOCAL_PARTS: ReadonlySet<string> = new Set([
  "abuse",
  "admin",
  "administrator",
  "billing",
  "bounce",
  "bounces",
  "do-not-reply",
  "donotreply",
  "ftp",
  "hostmaster",
  "list",
  "listserv",
  "mail",
  "mailer-daemon",
  "no-reply",
  "noreply",
  "null",
  "postmaster",
  "root",
  "security",
  "smtp",
  "webmaster",
  "www",
]);

export const MAX_LOCAL_PART_LENGTH = 32;
export const MAX_ADDRESS_LENGTH = 254;

const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/;
// A deliberately conservative subset of RFC 5322 addresses: no quoted local parts, no comments, no
// display names, no IP-literal domains. Anything exotic is rejected rather than interpreted.
const ADDRESS =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * Lowercases and validates a plain `local@domain` address. Returns null for anything else ("Name <a@b>",
 * several addresses, whitespace, control characters, over-long values). Plus-tags and dots are NOT
 * touched: `a+tag@x.com` and `a@x.com` are different addresses, so two people are never merged by
 * guesswork.
 */
export function normalizeEmailAddress(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  if (value.length === 0 || value.length > MAX_ADDRESS_LENGTH) return null;
  if (!ADDRESS.test(value)) return null;
  const [local] = value.split("@");
  return local.length <= 64 ? value : null;
}

export type LocalPartCheck =
  { ok: true; value: string } | { ok: false; reason: "invalid" | "reserved" };

/** Validates the local part an organization chooses for its support address (`<local>@platform-domain`). */
export function checkLocalPart(raw: string): LocalPartCheck {
  const value = raw.trim().toLowerCase();
  if (value.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART.test(value) || value.includes("..")) {
    return { ok: false, reason: "invalid" };
  }
  if (RESERVED_LOCAL_PARTS.has(value)) return { ok: false, reason: "reserved" };
  return { ok: true, value };
}

/** `<localPart>@<domain>` for a validated local part and platform domain; null if either is invalid. */
export function buildSupportAddress(localPart: string, domain: string): string | null {
  const local = checkLocalPart(localPart);
  const host = domain.trim().toLowerCase();
  if (!local.ok || !isValidEmailDomain(host)) return null;
  return `${local.value}@${host}`;
}

/**
 * Header values (subject, display name, message ids) must be single-line text. A CR, LF or NUL inside one
 * would let content smuggle extra headers (header injection), so such values are rejected outright.
 */
const UNSAFE_HEADER_CHARS = new RegExp("[\u0000-\u001f\u007f\u2028\u2029]");

export function isSafeHeaderValue(value: string): boolean {
  return !UNSAFE_HEADER_CHARS.test(value);
}

export function assertSafeHeaderValue(name: string, value: string): string {
  if (!isSafeHeaderValue(value)) throw new Error(`Unsafe characters in header ${name}`);
  return value;
}
