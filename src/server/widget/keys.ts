import { createHash, randomBytes } from "node:crypto";

/** The public identifier embedded in a website snippet. Not a secret; it only selects the organization. */
export function generatePublicKey(): string {
  return `wk_${randomBytes(18).toString("base64url")}`;
}

/** The visitor's bearer token. Random (256 bits); only its hash is stored. */
export function generateSessionToken(): string {
  return `vs_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** `lastSeenAt` (and the sliding expiry) are refreshed at most this often. */
export const TOUCH_INTERVAL_MS = 60 * 1000;
