import type { ZodType } from "zod";
import { MAX_PUBLIC_BODY_BYTES } from "@/features/widget/schemas";
import { AppError, UnauthorizedError, ValidationError } from "@/server/errors";

/**
 * Body parsing for PUBLIC endpoints: a hard size cap before parsing, strict schemas after. The
 * caller's identity is never read from the body.
 */
export async function parsePublicBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_PUBLIC_BODY_BYTES) {
    throw new AppError(413, "payload_too_large", "The request is too large");
  }
  let raw: unknown;
  try {
    raw = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  return schema.parse(raw);
}

/** The visitor bearer token from `Authorization: Bearer <token>`, or null. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  const match = header?.match(/^Bearer\s+(\S{20,200})$/i);
  return match ? match[1] : null;
}

export function requireBearerToken(request: Request): string {
  const token = bearerToken(request);
  if (!token) throw new UnauthorizedError("Visitor session required");
  return token;
}
