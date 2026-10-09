"use client";

import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { conversationsKeys } from "@/lib/query/query-keys";
import { useOrganizationScope } from "@/lib/query/query-provider";

const EVENT_TYPES = [
  "message.created",
  "conversation.created",
  "conversation.updated",
  "conversation.assigned",
  "conversation.status_changed",
] as const;

/** Realtime events are hints: refetch what the cache holds. The database stays the source of truth. */
export function applyInboxEvent(client: QueryClient, org: string | null) {
  void client.invalidateQueries({ queryKey: conversationsKeys.all(org) });
}

/**
 * Keeps the inbox current without a refresh. Opens ONE event stream for the caller's own
 * organization (the server derives the channel from the session; nothing is sent), invalidates
 * conversation queries when something changes, and reconciles after every reconnect (the browser
 * reconnects by itself; a fresh `ready` event means "refetch what you may have missed").
 * If the stream cannot be used (no permission, offline) the app keeps working with normal fetches.
 */
export function useInboxRealtime(url = "/api/realtime/inbox") {
  const client = useQueryClient();
  const org = useOrganizationScope();

  useEffect(() => {
    if (typeof EventSource === "undefined") return;
    const source = new EventSource(url);
    let connectedBefore = false;

    const onReady = () => {
      // The first `ready` is the initial connection (queries are already loading); later ones are reconnects.
      if (connectedBefore) applyInboxEvent(client, org);
      connectedBefore = true;
    };
    const onEvent = () => applyInboxEvent(client, org);

    source.addEventListener("ready", onReady);
    for (const type of EVENT_TYPES) source.addEventListener(type, onEvent);
    return () => source.close();
  }, [client, org, url]);
}

export function InboxRealtime() {
  useInboxRealtime();
  return null;
}
