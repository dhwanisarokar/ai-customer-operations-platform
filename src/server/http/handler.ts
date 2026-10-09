import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { createLogger } from "@/lib/logger";
import { AppError, ValidationError } from "@/server/errors";

const log = createLogger("api");

type RouteContext<P> = { params: Promise<P> };

export function errorBody(code: string, message: string, requestId: string, details?: unknown) {
  return { error: { code, message, requestId, ...(details === undefined ? {} : { details }) } };
}

/**
 * Wraps a route handler so every failure becomes a safe, structured JSON error:
 * AppError → its status, ZodError → 400, anything else → logged 500 with no internals leaked.
 */
export function apiHandler<P = Record<string, never>>(
  handler: (request: Request, context: RouteContext<P>) => Promise<Response>,
) {
  return async (request: Request, context: RouteContext<P>): Promise<Response> => {
    const requestId = randomUUID();
    try {
      return await handler(request, context);
    } catch (error) {
      if (error instanceof ZodError) {
        return NextResponse.json(
          errorBody("validation_error", "Invalid request", requestId, formatIssues(error)),
          { status: 400 },
        );
      }
      if (error instanceof AppError) {
        // 401/403 are security-relevant; keep them visible without logging request bodies.
        const level = error.status === 401 || error.status === 403 ? "warn" : "info";
        log[level]({ requestId, status: error.status, code: error.code, path: pathOf(request) });
        return NextResponse.json(errorBody(error.code, error.message, requestId, error.details), {
          status: error.status,
          headers: (error as AppError & { headers?: Record<string, string> }).headers,
        });
      }
      log.error({ requestId, err: error, path: pathOf(request) }, "unhandled API error");
      return NextResponse.json(errorBody("internal_error", "Something went wrong", requestId), {
        status: 500,
      });
    }
  };
}

/** Parses and validates a JSON body. Malformed JSON and schema violations both yield 400. */
export async function parseJsonBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new ValidationError("Request body must be valid JSON");
  }
  return schema.parse(raw);
}

/**
 * Validates URL query parameters. Unknown parameters (including any `organizationId` a client
 * adds) are ignored: the organization always comes from the authenticated context.
 */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}

function formatIssues(error: ZodError) {
  return error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}

function pathOf(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return "unknown";
  }
}
