import { randomBytes } from "node:crypto";

export { hashToken } from "@/server/widget/keys";

/** A portal invitation token. Random (256 bits); only its SHA-256 is stored. */
export function generateInviteToken(): string {
  return `pi_${randomBytes(32).toString("base64url")}`;
}

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
