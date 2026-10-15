import { MAX_MESSAGE_LENGTH, MAX_SUBJECT_LENGTH } from "@/features/conversations/schemas";
import { normalizeEmailAddress } from "./address";
import type { NormalizedInboundEmail } from "./provider";

/**
 * Pure helpers that turn the untrusted parts of an inbound email into values that are safe to store and
 * show. Everything here is plain text: nothing is ever interpreted as HTML or markup, and every value is
 * bounded, so a hostile sender cannot make the platform store unbounded or control-character content.
 */

// Bidirectional EMBEDDING/OVERRIDE/ISOLATE controls (U+202A-202E, U+2066-2069) can make "exe.pdf" display as
// "fdp.exe" or reorder a sentence, so they are removed everywhere. The harmless direction MARKS (LRM/RLM,
// U+200E/F) are kept: genuine right-to-left text is unaffected.
const BIDI = "\\u202a-\\u202e\\u2066-\\u2069";
// C0 controls except TAB (0x09) and LF (0x0a), DEL, the Unicode line/paragraph separators and bidi controls.
const BODY_CONTROL = new RegExp(
  `[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u2028\\u2029${BIDI}]`,
  "g",
);
const LINE_CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f\\u2028\\u2029${BIDI}]`, "g");
const RFC_ID = new RegExp("^<[^<>\\s\\u0000-\\u001f\\u007f]{1,510}>$");

export const EMPTY_BODY = "(no text content)";
export const EMPTY_SUBJECT = "(no subject)";
const TRUNCATION_NOTE = "\n\n[Message truncated]";

/** Cuts a string at a code-unit length without leaving half of a surrogate pair behind. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

/** Message text: LF line endings, no control characters, blank runs collapsed, bounded like a staff message. */
export function cleanBody(text: string): string {
  const cleaned = text
    .replace(/\r\n?/g, "\n")
    .replace(BODY_CONTROL, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  if (cleaned.length === 0) return EMPTY_BODY;
  if (cleaned.length <= MAX_MESSAGE_LENGTH) return cleaned;
  return cut(cleaned, MAX_MESSAGE_LENGTH - TRUNCATION_NOTE.length).trimEnd() + TRUNCATION_NOTE;
}

function singleLine(value: string): string {
  return value.replace(LINE_CONTROL, " ").replace(/\s+/g, " ").trim();
}

/** A conversation subject: one line, without the reply/forward prefixes, at most 200 characters. */
export function cleanSubject(subject: string): string {
  const line = singleLine(subject).replace(/^(?:\s*(?:re|fw|fwd|aw|sv)\s*:\s*)+/i, "");
  const bounded = cut(line, MAX_SUBJECT_LENGTH).trim();
  return bounded.length > 0 ? bounded : EMPTY_SUBJECT;
}

/** A display name for storage: one line, no control or bidi characters, bounded; null when nothing is left. */
export function cleanDisplayName(value: string | null, max = 200): string | null {
  if (!value) return null;
  const line = cut(singleLine(value), max).trim();
  return line.length > 0 ? line : null;
}

/** To/Cc for the timeline: valid plain addresses only, lower-case, de-duplicated, at most 50. */
export function cleanAddressList(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => normalizeEmailAddress(value) ?? []))].slice(0, 50);
}

/** The subject as received (bounded, one line) for the email record. */
export function rawSubject(subject: string): string {
  return cut(singleLine(subject), 500);
}

/** A first name for a customer created from an email: the display name, else the address' local part. */
export function displayFirstName(fromName: string | null, address: string): string {
  const fromDisplay = singleLine((fromName ?? "").replace(/[<>"]/g, ""));
  const candidate = fromDisplay || address.split("@")[0] || "Unknown";
  return cut(candidate, 100).trim() || "Unknown";
}

/** An RFC 5322 id (`<local@host>`) or null. Anything else is ignored, never used for threading. */
export function validRfcId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return RFC_ID.test(trimmed) ? trimmed : null;
}

export function validRfcIds(values: string[]): string[] {
  return [...new Set(values.flatMap((value) => validRfcId(value) ?? []))].slice(0, 50);
}

export type AttachmentInfo = { filename: string; contentType: string; size: number };

/** Attachment METADATA only. Names and types are sanitized; content is never read. */
export function cleanAttachments(
  attachments: NormalizedInboundEmail["attachments"],
): AttachmentInfo[] {
  return attachments.slice(0, 50).map((attachment) => ({
    filename: cut(singleLine(attachment.filename), 255) || "attachment",
    contentType: cut(singleLine(attachment.contentType), 200) || "application/octet-stream",
    size: Math.max(0, Math.floor(attachment.size)),
  }));
}

/** Senders that are mail systems (bounce notices, delivery daemons), not customers. */
const SYSTEM_LOCAL_PARTS = new Set(["mailer-daemon", "postmaster"]);
export function isSystemSender(address: string): boolean {
  return SYSTEM_LOCAL_PARTS.has(address.split("@")[0]);
}
