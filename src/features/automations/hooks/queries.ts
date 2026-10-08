import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { automationsKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import {
  AUTOMATIONS_PAGE,
  isActiveStatus,
  type AutomationListResponse,
  type AutomationResponse,
  type ExecutionListResponse,
  type ExecutionResponse,
} from "../api/types";

type Options<T> = { initialData?: T };

const pageQuery = `page=${AUTOMATIONS_PAGE.page}&pageSize=${AUTOMATIONS_PAGE.pageSize}`;

export function useAutomations(options: Options<AutomationListResponse> = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: automationsKeys.list(org, AUTOMATIONS_PAGE),
    queryFn: ({ signal }) =>
      fetchJson<AutomationListResponse>(`/api/automations?${pageQuery}`, { signal }),
    staleTime: 15_000,
    ...options,
  });
}

export function useAutomation(id: string, options: Options<AutomationResponse> = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: automationsKeys.detail(org, id),
    queryFn: ({ signal }) => fetchJson<AutomationResponse>(`/api/automations/${id}`, { signal }),
    staleTime: 15_000,
    ...options,
  });
}

/** Execution history. While any run is queued or running it refreshes every 1.5 seconds. */
export function useAutomationExecutions(id: string, options: Options<ExecutionListResponse> = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: automationsKeys.executions(org, id, AUTOMATIONS_PAGE),
    queryFn: ({ signal }) =>
      fetchJson<ExecutionListResponse>(`/api/automations/${id}/executions?${pageQuery}`, {
        signal,
      }),
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.items.some((run) => isActiveStatus(run.status)) ? 1_500 : false,
    ...options,
  });
}

export function useAutomationExecution(
  id: string,
  executionId: string,
  options: Options<ExecutionResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: automationsKeys.execution(org, id, executionId),
    queryFn: ({ signal }) =>
      fetchJson<ExecutionResponse>(`/api/automations/${id}/executions/${executionId}`, { signal }),
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data && isActiveStatus(query.state.data.execution.status) ? 1_500 : false,
    ...options,
  });
}
