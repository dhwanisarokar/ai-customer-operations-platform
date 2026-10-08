import { Badge } from "@/components/ui/badge";
import { EXECUTION_STATUS_LABEL, type ExecutionJson } from "../api/types";

const VARIANT: Record<
  ExecutionJson["status"],
  "default" | "secondary" | "destructive" | "outline"
> = {
  QUEUED: "outline",
  RUNNING: "secondary",
  COMPLETED: "default",
  FAILED: "destructive",
  CANCELLED: "outline",
};

export function ExecutionStatusBadge({ status }: { status: ExecutionJson["status"] }) {
  return <Badge variant={VARIANT[status]}>{EXECUTION_STATUS_LABEL[status]}</Badge>;
}
