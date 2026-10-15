import { getDb, type Db } from "@/db/client";
import { isUniqueViolation } from "@/db/errors";
import type { AutomationExecutionStatus, Prisma } from "@/generated/prisma/client";

const executionSelect = {
  id: true,
  automationId: true,
  eventId: true,
  eventType: true,
  status: true,
  attempts: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  errorCode: true,
  errorMessage: true,
  eventData: true,
  definition: true,
  conditionResults: true,
  actionResults: true,
} satisfies Prisma.AutomationExecutionSelect;

export type ExecutionRecord = Prisma.AutomationExecutionGetPayload<{
  select: typeof executionSelect;
}>;

/** A run that crashed while RUNNING can be taken over after this long without a heartbeat. */
export const STALE_LOCK_MS = 5 * 60 * 1000;

export const automationExecutionsRepository = {
  /**
   * Creates the execution for (automation, event). The unique key makes this the idempotency point:
   * a second attempt for the same event returns null instead of a second execution.
   */
  async createIfAbsent(
    organizationId: string,
    data: {
      automationId: string;
      eventId: string;
      eventType: string;
      eventData: Prisma.InputJsonValue;
      definition: Prisma.InputJsonValue;
      conditionResults: Prisma.InputJsonValue;
    },
    db: Db = getDb(),
  ): Promise<ExecutionRecord | null> {
    try {
      return await db.automationExecution.create({
        data: { organizationId, ...data },
        select: executionSelect,
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  },

  /** The execution of (automation, event), if one was recorded. */
  findByEvent(
    organizationId: string,
    automationId: string,
    eventId: string,
    db: Db = getDb(),
  ): Promise<ExecutionRecord | null> {
    return db.automationExecution.findFirst({
      where: { organizationId, automationId, eventId },
      select: executionSelect,
    });
  },

  findById(organizationId: string, id: string, db: Db = getDb()): Promise<ExecutionRecord | null> {
    return db.automationExecution.findFirst({
      where: { id, organizationId },
      select: executionSelect,
    });
  },

  async listForAutomation(
    organizationId: string,
    automationId: string,
    page: { skip: number; take: number },
    db: Db = getDb(),
  ): Promise<{ items: ExecutionRecord[]; total: number }> {
    const where = { organizationId, automationId };
    const [items, total] = await Promise.all([
      db.automationExecution.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        skip: page.skip,
        take: page.take,
        select: executionSelect,
      }),
      db.automationExecution.count({ where }),
    ]);
    return { items, total };
  },

  /**
   * Atomically takes ownership of a run: QUEUED -> RUNNING, or RUNNING with a stale lock (crashed
   * worker). Exactly one concurrent caller gets `true`; finished runs can never be claimed.
   */
  async claim(organizationId: string, id: string, now: Date, db: Db = getDb()): Promise<boolean> {
    const staleBefore = new Date(now.getTime() - STALE_LOCK_MS);
    const result = await db.automationExecution.updateMany({
      where: {
        id,
        organizationId,
        OR: [{ status: "QUEUED" }, { status: "RUNNING", lockedAt: { lt: staleBefore } }],
      },
      data: { status: "RUNNING", lockedAt: now, startedAt: now, attempts: { increment: 1 } },
    });
    return result.count === 1;
  },

  async saveProgress(
    organizationId: string,
    id: string,
    actionResults: Prisma.InputJsonValue,
    now: Date,
    db: Db = getDb(),
  ): Promise<void> {
    // Doubles as a heartbeat: keeps the lock fresh while a long run makes progress.
    await db.automationExecution.updateMany({
      where: { id, organizationId, status: "RUNNING" },
      data: { actionResults, lockedAt: now },
    });
  },

  /** RUNNING -> a resting state. Only called by the worker that holds the claim. */
  async settle(
    organizationId: string,
    id: string,
    outcome: {
      status: Extract<AutomationExecutionStatus, "QUEUED" | "COMPLETED" | "FAILED" | "CANCELLED">;
      actionResults?: Prisma.InputJsonValue;
      errorCode?: string | null;
      errorMessage?: string | null;
    },
    now: Date,
    db: Db = getDb(),
  ): Promise<void> {
    const finished = outcome.status !== "QUEUED";
    await db.automationExecution.updateMany({
      where: { id, organizationId, status: "RUNNING" },
      data: {
        status: outcome.status,
        lockedAt: null,
        completedAt: finished ? now : null,
        errorCode: outcome.errorCode ?? null,
        errorMessage: outcome.errorMessage ?? null,
        ...(outcome.actionResults !== undefined ? { actionResults: outcome.actionResults } : {}),
      },
    });
  },

  /** QUEUED -> CANCELLED / FAILED for runs that never started (disabled automation, queue down). */
  async finishQueued(
    organizationId: string,
    id: string,
    outcome: { status: "CANCELLED" | "FAILED"; errorCode: string; errorMessage: string },
    now: Date,
    db: Db = getDb(),
  ): Promise<void> {
    await db.automationExecution.updateMany({
      where: { id, organizationId, status: "QUEUED" },
      data: { ...outcome, completedAt: now },
    });
  },
};
