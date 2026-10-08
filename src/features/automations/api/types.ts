import type { Serialized } from "@/lib/query/serialize";
import type { Page } from "@/server/http/pagination";
import type {
  AutomationDto,
  ExecutionDetailDto,
  ExecutionDto,
} from "@/server/services/automations";

export type AutomationJson = Serialized<AutomationDto>;
export type AutomationListResponse = Serialized<Page<AutomationDto>>;
export type AutomationResponse = { automation: AutomationJson };

export type ExecutionJson = Serialized<ExecutionDto>;
export type ExecutionListResponse = Serialized<Page<ExecutionDto>>;
export type ExecutionDetailJson = Serialized<ExecutionDetailDto>;
export type ExecutionResponse = { execution: ExecutionDetailJson };

/** Pages of 50 are plenty for the first version (no paging controls yet). */
export const AUTOMATIONS_PAGE = { page: 1, pageSize: 50 } as const;

export type ConditionValue = { field: string; operator: string; value?: string | number };
export type ActionValue = { type: string; input: Record<string, unknown> };

export type AutomationFormValues = {
  name: string;
  description: string | null;
  enabled: boolean;
  trigger: string;
  conditions: ConditionValue[];
  actions: ActionValue[];
};

export const EXECUTION_STATUS_LABEL: Record<ExecutionJson["status"], string> = {
  QUEUED: "Queued",
  RUNNING: "Running",
  COMPLETED: "Completed",
  FAILED: "Failed",
  CANCELLED: "Cancelled",
};

/** A run that is still going: the history keeps refreshing until it settles. */
export const isActiveStatus = (status: ExecutionJson["status"]) =>
  status === "QUEUED" || status === "RUNNING";
