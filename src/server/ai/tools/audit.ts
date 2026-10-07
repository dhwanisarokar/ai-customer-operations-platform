import { createLogger } from "@/lib/logger";
import { aiToolAuditRepository } from "@/server/repositories/ai-tool-audit";
import type { ToolExecutionContext } from "./types";

const log = createLogger("ai.tools");

/**
 * Writes the tool audit row (who, which tool, risk, approval, outcome; never inputs or results).
 * A failure to audit must not break the request it describes, but it is always logged loudly.
 */
export async function audit(
  ec: ToolExecutionContext,
  entry: Parameters<typeof aiToolAuditRepository.record>[0],
) {
  try {
    await aiToolAuditRepository.record(entry);
  } catch (error) {
    log.error(
      { organizationId: ec.ctx.organization.id, toolName: entry.toolName, err: String(error) },
      "failed to write tool audit record",
    );
  }
}
