import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { automationsKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import type { AutomationFormValues, AutomationResponse } from "../api/types";

/*
 * Automation mutations are NOT optimistic: they change what runs for the whole organization, and
 * the server validates the definition against the registries and the caller's permissions. The
 * server's response becomes the cached value.
 */

function useRefresh() {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return (id?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: automationsKeys.lists(org) }),
      ...(id ? [queryClient.invalidateQueries({ queryKey: automationsKeys.detail(org, id) })] : []),
    ]);
}

export function useCreateAutomation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (values: AutomationFormValues) =>
      fetchJson<AutomationResponse>("/api/automations", { method: "POST", body: values }),
    onSuccess: (data) => refresh(data.automation.id),
  });
}

export function useUpdateAutomation(id: string) {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (values: AutomationFormValues) =>
      fetchJson<AutomationResponse>(`/api/automations/${id}`, { method: "PATCH", body: values }),
    onSuccess: () => refresh(id),
  });
}

export function useSetAutomationEnabled() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      fetchJson<AutomationResponse>(`/api/automations/${id}/${enabled ? "enable" : "disable"}`, {
        method: "POST",
      }),
    onSuccess: (data) => refresh(data.automation.id),
  });
}

export function useDeleteAutomation() {
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: string) => fetchJson<null>(`/api/automations/${id}`, { method: "DELETE" }),
    onSuccess: () => refresh(),
  });
}
