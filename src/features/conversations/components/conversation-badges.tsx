import { Badge } from "@/components/ui/badge";
import { priorityLabel, statusLabel } from "../event-text";

const STATUS_VARIANT = { OPEN: "default", PENDING: "secondary", RESOLVED: "outline" } as const;
const PRIORITY_VARIANT = {
  LOW: "secondary",
  NORMAL: "outline",
  HIGH: "default",
  URGENT: "destructive",
} as const;

export function ConversationStatusBadge({ status }: { status: keyof typeof STATUS_VARIANT }) {
  return <Badge variant={STATUS_VARIANT[status]}>{statusLabel(status)}</Badge>;
}

/** NORMAL is the unremarkable default, so lists only badge the priorities worth noticing. */
export function ConversationPriorityBadge({
  priority,
  showNormal = false,
}: {
  priority: keyof typeof PRIORITY_VARIANT;
  showNormal?: boolean;
}) {
  if (priority === "NORMAL" && !showNormal) return null;
  return <Badge variant={PRIORITY_VARIANT[priority]}>{priorityLabel(priority)}</Badge>;
}
