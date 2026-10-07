import { requestApproval } from "@/server/services/ai-approvals";
import { audit } from "./audit";
import { toToolError } from "./errors";
import { defaultToolRegistry, resolveTool, type ToolRegistry } from "./registry";
import { ToolError, type ToolExecutionContext, type ToolOutcome } from "./types";

/**
 * Runs ONE model-requested tool call. The model supplies only a name and arguments; everything
 * else is decided here by deterministic code, in this order:
 *
 *   known tool? -> arguments valid (strict Zod, no org/user fields)? -> caller's role has the
 *   tool's permission? -> risk policy: LOW executes now, anything else becomes a pending approval.
 *
 * Nothing the model says (including "allow", "approved" or another organization id) can change the
 * outcome. Errors are structured and safe; this function never throws for tool-level problems.
 */
export async function runTool(
  ec: ToolExecutionContext,
  name: string,
  rawArgs: unknown,
  registry: ToolRegistry = defaultToolRegistry,
): Promise<ToolOutcome> {
  const { ctx } = ec;
  const base = {
    organizationId: ctx.organization.id,
    conversationId: ec.conversationId,
    actorUserId: ctx.user.id,
  };

  let tool;
  try {
    tool = resolveTool(name, registry);
  } catch (error) {
    return fail(toToolError(error));
  }
  const audited = { ...base, toolName: tool.name, riskLevel: tool.riskLevel };

  const parsed = tool.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    await audit(ec, { ...audited, outcome: "FAILURE", errorCode: "VALIDATION_ERROR" });
    const detail = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
      .join("; ");
    return fail(new ToolError("VALIDATION_ERROR", `Invalid arguments (${detail}).`));
  }
  const input = parsed.data;

  // Authorization: the caller's real role, from the authenticated session.
  if (!ctx.can(tool.requiredPermission)) {
    await audit(ec, { ...audited, outcome: "DENIED", errorCode: "FORBIDDEN" });
    return fail(new ToolError("FORBIDDEN", "You do not have permission to perform this action."));
  }

  try {
    if (tool.riskLevel === "LOW") {
      const result = await tool.execute(ec, input);
      await audit(ec, { ...audited, outcome: "SUCCESS" });
      return { status: "ok", result };
    }

    // Risk policy: mutating tools never execute here. Describe the change from current data (this
    // also rejects requests that can never be valid) and wait for a human.
    if (!tool.preview)
      throw new ToolError("EXECUTION_FAILED", "This tool cannot request approval.");
    const preview = await tool.preview(ec, input);
    const approval = await requestApproval(ec, tool, input, preview);
    await audit(ec, { ...audited, approvalId: approval.id, outcome: "APPROVAL_REQUESTED" });
    return { status: "approval_required", approval };
  } catch (error) {
    const toolError = toToolError(error, {
      toolName: tool.name,
      organizationId: base.organizationId,
    });
    await audit(ec, { ...audited, outcome: "FAILURE", errorCode: toolError.toolCode });
    return fail(toolError);
  }
}

function fail(error: ToolError): ToolOutcome {
  return { status: "error", error: { code: error.toolCode, message: error.message } };
}
