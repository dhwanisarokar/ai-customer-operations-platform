import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { STALE_TIME } from "@/lib/query/query-client";
import { membersKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import type { MembersResponse } from "@/features/conversations/api/types";

/**
 * Members of the active organization (assignee picker, name lookups). The organization id is in
 * the URL only because the existing endpoint is organization-scoped; the server still verifies the
 * caller's membership, so a tampered id yields 404.
 */
export function useMembers(options: { initialData?: MembersResponse } = {}) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: membersKeys.list(org),
    queryFn: ({ signal }) =>
      fetchJson<MembersResponse>(`/api/organizations/${org}/members`, { signal }),
    staleTime: STALE_TIME.members,
    enabled: org !== null,
    ...options,
  });
}
