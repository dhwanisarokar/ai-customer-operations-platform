import { getDb } from "@/db/client";
import { createLogger } from "@/lib/logger";

const log = createLogger("health");

export type HealthStatus = {
  status: "ok" | "degraded";
  checks: { database: "up" | "down" };
};

export async function checkHealth(): Promise<HealthStatus> {
  let database: "up" | "down" = "up";
  try {
    await getDb().$queryRaw`SELECT 1`;
  } catch (error) {
    database = "down";
    log.error({ err: error }, "database health check failed");
  }
  return { status: database === "up" ? "ok" : "degraded", checks: { database } };
}
