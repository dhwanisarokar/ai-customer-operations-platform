import { getDb, type Db } from "@/db/client";

/** Not tenant data: one row per kind of background pass, shared by every worker. */
export const workerHeartbeatRepository = {
  async recordSuccess(name: string, now: Date, db: Db = getDb()): Promise<void> {
    await db.workerHeartbeat.upsert({
      where: { name },
      create: { name, lastRunAt: now, lastSuccessAt: now, lastError: null },
      update: { lastRunAt: now, lastSuccessAt: now, lastError: null, updatedAt: now },
    });
  },

  /** A pass that failed: `lastRunAt` moves (the worker is alive), `lastSuccessAt` does not. */
  async recordFailure(name: string, code: string, now: Date, db: Db = getDb()): Promise<void> {
    await db.workerHeartbeat.upsert({
      where: { name },
      create: { name, lastRunAt: now, lastSuccessAt: null, lastError: code },
      update: { lastRunAt: now, lastError: code, updatedAt: now },
    });
  },

  find(name: string, db: Db = getDb()) {
    return db.workerHeartbeat.findUnique({ where: { name } });
  },
};
