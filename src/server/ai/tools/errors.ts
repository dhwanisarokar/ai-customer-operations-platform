import { createLogger } from "@/lib/logger";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from "@/server/errors";
import { ToolError } from "./types";

const log = createLogger("ai.tools");

/**
 * Maps anything thrown while running a tool to a structured, SAFE error. Application errors carry
 * messages that are already safe to show; anything else (database, provider, bugs) is logged in
 * full on the server and replaced by a generic message, so internals never reach the model or UI.
 */
export function toToolError(error: unknown, context: Record<string, unknown> = {}): ToolError {
  if (error instanceof ToolError) return error;
  if (error instanceof NotFoundError) return new ToolError("NOT_FOUND", "Not found.");
  if (error instanceof ForbiddenError) {
    return new ToolError("FORBIDDEN", "You do not have permission to perform this action.");
  }
  if (error instanceof ValidationError) return new ToolError("VALIDATION_ERROR", error.message);
  if (error instanceof ConflictError) return new ToolError("EXECUTION_FAILED", error.message);
  if (error instanceof AppError) return new ToolError("EXECUTION_FAILED", error.message);
  log.error(
    {
      ...context,
      err: error instanceof Error ? { name: error.name, message: error.message } : "unknown",
    },
    "tool execution failed",
  );
  return new ToolError("EXECUTION_FAILED", "The action could not be completed.");
}
