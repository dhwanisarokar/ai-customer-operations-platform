"use client";

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/lib/api-client";
import { portalApi } from "./api";
import { usePortalInfo } from "./portal-context";
import {
  PORTAL_PAGE_SIZE,
  portalKeys,
  type HelpArticle,
  type HelpArticleSummary,
  type Paged,
  type PortalConversationDto,
  type PortalConversationResponse,
  type PortalMe,
  type PortalProfile,
  type PortalSummary,
} from "./types";

const STALE = 10_000;

export function usePortalMe() {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.me(slug),
    queryFn: ({ signal }) => fetchJson<PortalMe>(portalApi(slug, "/me"), { signal }),
    staleTime: STALE,
  });
}

export function usePortalSummary() {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.summary(slug),
    queryFn: ({ signal }) => fetchJson<PortalSummary>(portalApi(slug, "/summary"), { signal }),
    staleTime: STALE,
  });
}

export function usePortalConversations(page: number) {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.conversationList(slug, page),
    queryFn: ({ signal }) =>
      fetchJson<Paged<PortalConversationDto>>(
        portalApi(slug, `/conversations?page=${page}&pageSize=${PORTAL_PAGE_SIZE}`),
        { signal },
      ),
    placeholderData: keepPreviousData,
    staleTime: STALE,
  });
}

export function usePortalConversation(conversationId: string, live: boolean) {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.conversation(slug, conversationId),
    queryFn: ({ signal }) =>
      fetchJson<PortalConversationResponse>(portalApi(slug, `/conversations/${conversationId}`), {
        signal,
      }),
    // While the realtime stream is down, poll instead.
    refetchInterval: live ? false : 8000,
    staleTime: STALE,
  });
}

export function useHelpSearch(q: string, page: number) {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.help(slug, q, page),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ page: String(page), pageSize: "10" });
      if (q.trim()) params.set("q", q.trim());
      return fetchJson<Paged<HelpArticleSummary>>(portalApi(slug, `/help?${params}`), { signal });
    },
    placeholderData: keepPreviousData,
  });
}

export function useHelpArticle(articleId: string) {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.article(slug, articleId),
    queryFn: ({ signal }) =>
      fetchJson<{ article: HelpArticle }>(portalApi(slug, `/help/${articleId}`), { signal }),
  });
}

export function usePortalProfile() {
  const { slug } = usePortalInfo();
  return useQuery({
    queryKey: portalKeys.profile(slug),
    queryFn: ({ signal }) =>
      fetchJson<{ profile: PortalProfile }>(portalApi(slug, "/profile"), { signal }),
  });
}

export function useUpdateProfile() {
  const { slug } = usePortalInfo();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (changes: {
      firstName?: string;
      lastName?: string | null;
      phone?: string | null;
    }) =>
      fetchJson<{ profile: PortalProfile }>(portalApi(slug, "/profile"), {
        method: "PATCH",
        body: changes,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(portalKeys.profile(slug), data);
      void queryClient.invalidateQueries({ queryKey: portalKeys.me(slug) });
    },
  });
}

export function useCreateConversation() {
  const { slug } = usePortalInfo();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { subject: string; body: string; clientMessageId: string }) =>
      fetchJson<PortalConversationResponse>(portalApi(slug, "/conversations"), {
        method: "POST",
        body: input,
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(portalKeys.conversation(slug, data.conversation.id), data);
      void queryClient.invalidateQueries({ queryKey: portalKeys.conversations(slug) });
      void queryClient.invalidateQueries({ queryKey: portalKeys.summary(slug) });
    },
  });
}

export function useRequestHuman(conversationId: string) {
  const { slug } = usePortalInfo();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      fetchJson<{ humanRequested: boolean }>(
        portalApi(slug, `/conversations/${conversationId}/handoff`),
        { method: "POST" },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: portalKeys.conversation(slug, conversationId) }),
  });
}

export function useJoinPortal() {
  const { slug } = usePortalInfo();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      fetchJson<{ linked: boolean; alreadyLinked: boolean }>(portalApi(slug, "/join"), {
        method: "POST",
        body: { token },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: portalKeys.all(slug) }),
  });
}
