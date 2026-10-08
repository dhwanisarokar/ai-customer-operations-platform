import type { z } from "zod";
import type { OrganizationContext } from "@/server/auth/context";
import type { Permission } from "@/server/auth/permissions";
import { AppError } from "@/server/errors";

/**
 * Risk is defined by the application per tool, never by the model:
 * LOW executes immediately; MEDIUM and HIGH always wait for a human approval.
 */
export type ToolRiskLevel = "LOW" | "MEDIUM" | "HIGH";

/** Structured, safe error codes. Raw database/provider errors never leave the server. */
export const TOOL_ERROR_CODES = [
  "UNKNOWN_TOOL",
  "VALIDATION_ERROR",
  "NOT_FOUND",
  "FORBIDDEN",
  "APPROVAL_REQUIRED",
  "APPROVAL_EXPIRED",
  "EXECUTION_FAILED",
  "TOOL_LIMIT_REACHED",
  "NOT_CUSTOMER_REQUEST",
] as const;
export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

const STATUS_BY_CODE: Record<ToolErrorCode, number> = {
  UNKNOWN_TOOL: 400,
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  APPROVAL_REQUIRED: 409,
  APPROVAL_EXPIRED: 409,
  EXECUTION_FAILED: 422,
  TOOL_LIMIT_REACHED: 429,
  NOT_CUSTOMER_REQUEST: 422,
};

export class ToolError extends AppError {
  constructor(
    readonly toolCode: ToolErrorCode,
    message: string,
  ) {
    super(STATUS_BY_CODE[toolCode], toolCode.toLowerCase(), message);
  }
}

/**
 * Trusted facts about WHO is acting and WHERE. Built on the server from the authenticated session
 * (requireOrganizationContext). The model can never supply or change any of it: tool inputs are
 * strict schemas without organization, user or permission fields.
 */
export type ToolExecutionContext = {
  ctx: OrganizationContext;
  /** The conversation the AI was invoked from, if any. */
  conversationId: string | null;
  /**
   * Set when the AI itself is acting (the tool pass): what the CUSTOMER actually asked for. It is
   * derived from message authorship stored in the database, never from the model. Changes the AI
   * proposes must be justified by it. Absent for human-initiated execution (an approver).
   */
  trigger?: ToolTrigger;
};

/**
 * The customer's own words that may justify a change: the contiguous run of CUSTOMER-authored
 * messages at the end of the conversation. Empty when the last customer-facing message was written
 * by staff or by the AI (nobody is waiting for an action), and it never contains agent replies,
 * AI messages or internal notes.
 */
export type ToolTrigger = { customerText: string };

/** What an approver sees. Built by the application from current data, never by the model. */
export type ToolPreview = {
  title: string;
  lines: { label: string; from: string | null; to: string | null }[];
};

export type ToolDefinition<TInput = unknown, TResult = unknown> = {
  name: string;
  /** Shown to the model so it knows when to request the tool. */
  description: string;
  inputSchema: z.ZodType<TInput>;
  riskLevel: ToolRiskLevel;
  /** Checked against the caller's real role by application code (the existing RBAC). */
  requiredPermission: Permission;
  execute: (context: ToolExecutionContext, input: TInput) => Promise<TResult>;
  /**
   * Mutating tools only: a deterministic check that the proposed change is something the customer
   * said. Returns a reason when it is not (the request is then refused, nothing is stored).
   */
  provenance?: (input: TInput, trigger: ToolTrigger) => string | null;
  /**
   * Required for tools that need approval: describes the exact change using current data and
   * throws (NOT_FOUND / VALIDATION_ERROR) when the request cannot be valid, so no approval is
   * created for it.
   */
  preview?: (context: ToolExecutionContext, input: TInput) => Promise<ToolPreview>;
};

export type ApprovalDto = {
  id: string;
  conversationId: string | null;
  toolName: string;
  riskLevel: ToolRiskLevel;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "EXECUTED" | "FAILED";
  preview: ToolPreview;
  requestedByUserId: string;
  createdAt: Date;
  expiresAt: Date;
  failureCode: string | null;
};

export type ToolOutcome =
  | { status: "ok"; result: unknown }
  | { status: "approval_required"; approval: ApprovalDto }
  | { status: "error"; error: { code: ToolErrorCode; message: string } };

/** Approvals expire quickly: an old approval must not be able to execute a stale mutation. */
export const APPROVAL_TTL_MS = 15 * 60 * 1000;
/** Hard cap on tool calls per AI request. */
export const MAX_TOOL_CALLS = 5;
/** Hard cap on simultaneously pending approvals per conversation. */
export const MAX_PENDING_APPROVALS = 10;
