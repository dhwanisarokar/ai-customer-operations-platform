import { getDb, type Db } from "@/db/client";
import type { OutboundEmailStatus } from "@/generated/prisma/client";

/**
 * Append-only: this file only INSERTS and READS; no function updates or deletes an audit row. It holds no message text
 * and no address. Always written in the same transaction as the state change it records.
 */
export type NewAudit = {
  organizationId: string;
  outboundEmailId: string;
  action:
    "recheck_found" | "recheck_not_found" | "recheck_unavailable" | "operator_confirmed_not_sent";
  previousStatus: OutboundEmailStatus;
  newStatus: OutboundEmailStatus;
  actor: { kind: "user"; userId: string } | { kind: "operator"; label: string };
  reason: string | null;
};

export const outboundEmailAuditRepository = {
  insert(data: NewAudit, db: Db = getDb()) {
    return db.outboundEmailAudit.create({
      data: {
        organizationId: data.organizationId,
        outboundEmailId: data.outboundEmailId,
        action: data.action,
        previousStatus: data.previousStatus,
        newStatus: data.newStatus,
        actorKind: data.actor.kind,
        actorUserId: data.actor.kind === "user" ? data.actor.userId : null,
        operatorLabel: data.actor.kind === "operator" ? data.actor.label : null,
        reason: data.reason,
      },
      select: { id: true },
    });
  },

  listForSend(organizationId: string, outboundEmailId: string, db: Db = getDb()) {
    return db.outboundEmailAudit.findMany({
      where: { organizationId, outboundEmailId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  },
};
