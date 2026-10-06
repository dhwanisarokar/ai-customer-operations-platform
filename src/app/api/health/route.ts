import { NextResponse } from "next/server";
import { checkHealth } from "@/server/services/health";

export const dynamic = "force-dynamic";

export async function GET() {
  const health = await checkHealth();
  return NextResponse.json(health, { status: health.status === "ok" ? 200 : 503 });
}
