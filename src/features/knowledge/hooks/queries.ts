import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { STALE_TIME } from "@/lib/query/query-client";
import { knowledgeKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import { knowledgeListUrl } from "../api/requests";
import type { KnowledgeDocumentResponse, KnowledgeListResponse } from "../api/types";
import type { ListDocumentsQuery } from "../schemas";

type Options<T> = { initialData?: T; enabled?: boolean };

/** Knowledge articles change rarely and editing is explicit, so they stay fresh the longest. */
export function useKnowledgeDocuments(
  query: ListDocumentsQuery,
  options: Options<KnowledgeListResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: knowledgeKeys.list(org, query),
    queryFn: ({ signal }) => fetchJson<KnowledgeListResponse>(knowledgeListUrl(query), { signal }),
    staleTime: STALE_TIME.knowledge,
    placeholderData: keepPreviousData,
    ...options,
  });
}

export function useKnowledgeDocument(
  documentId: string,
  options: Options<KnowledgeDocumentResponse> = {},
) {
  const org = useOrganizationScope();
  return useQuery({
    queryKey: knowledgeKeys.detail(org, documentId),
    queryFn: ({ signal }) =>
      fetchJson<KnowledgeDocumentResponse>(`/api/knowledge/${documentId}`, { signal }),
    staleTime: STALE_TIME.knowledge,
    ...options,
  });
}
