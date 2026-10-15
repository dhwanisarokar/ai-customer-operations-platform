import { NextResponse } from "next/server";
import { checkBackgroundHealth } from "@/server/services/background-health";

export const dynamic = "force-dynamic";

/**
 * Health of the background worker (event reconciliation, retention). Point an EXTERNAL uptime monitor or alert
 * at this, not an orchestrator's liveness probe: a stopped worker should page someone, not remove web
 * instances from rotation (`/api/health` is the web tier's own check). Coarse states and ages only.
 */
export async function GET() {
  const health = await checkBackgroundHealth();
  return NextResponse.json(health, { status: health.status === "ok" ? 200 : 503 });
}
