import { useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { knowledgeKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";
import type { KnowledgeDocumentResponse, KnowledgeFormValues } from "../api/types";

/*
 * Knowledge mutations are NOT optimistic. Publishing and editing live content call the embedding
 * model and swap vectors in a transaction; pretending that already succeeded would show "published"
 * for a document the AI cannot use yet. The UI uses the mutation's pending state instead, and the
 * server's response becomes the cached value.
 */

export function useCreateKnowledgeDocument() {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: (values: KnowledgeFormValues) =>
      fetchJson<KnowledgeDocumentResponse>("/api/knowledge", { method: "POST", body: values }),
    onSuccess: (data) => {
      queryClient.setQueryData(knowledgeKeys.detail(org, data.document.id), data);
      return queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists(org) });
    },
  });
}

export function useUpdateKnowledgeDocument(documentId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: (values: KnowledgeFormValues) =>
      fetchJson<KnowledgeDocumentResponse>(`/api/knowledge/${documentId}`, {
        method: "PATCH",
        body: values,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(knowledgeKeys.detail(org, documentId), data);
      return queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists(org) });
    },
  });
}

function useStatusMutation(documentId: string, action: "publish" | "unpublish" | "archive") {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationKey: [...knowledgeKeys.detail(org, documentId), "mutation", action],
    mutationFn: () =>
      fetchJson<KnowledgeDocumentResponse>(`/api/knowledge/${documentId}/${action}`, {
        method: "POST",
      }),
    onSuccess: (data) => queryClient.setQueryData(knowledgeKeys.detail(org, documentId), data),
    // Success or failure, the list and the detail are re-read from the server.
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists(org) }),
        queryClient.invalidateQueries({ queryKey: knowledgeKeys.detail(org, documentId) }),
      ]),
  });
}

export const usePublishKnowledgeDocument = (documentId: string) =>
  useStatusMutation(documentId, "publish");
export const useUnpublishKnowledgeDocument = (documentId: string) =>
  useStatusMutation(documentId, "unpublish");
export const useArchiveKnowledgeDocument = (documentId: string) =>
  useStatusMutation(documentId, "archive");

export function useDeleteKnowledgeDocument(documentId: string) {
  const queryClient = useQueryClient();
  const org = useOrganizationScope();
  return useMutation({
    mutationFn: () => fetchJson<null>(`/api/knowledge/${documentId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: knowledgeKeys.detail(org, documentId) });
      return queryClient.invalidateQueries({ queryKey: knowledgeKeys.lists(org) });
    },
  });
}
