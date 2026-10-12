"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { portalApi } from "./api";
import { portalKeys } from "./types";

const EVENT_TYPES = [
  "message.created",
  "conversation.created",
  "conversation.updated",
  "conversation.assigned",
  "conversation.status_changed",
] as const;

/**
 * Keeps the portal current without a refresh, over the existing SSE realtime (a channel derived on the
 * server from the signed-in customer's verified link). Events are hints: the portal queries refetch.
 * After every reconnect it refetches everything it may have missed. Returns whether the stream is live
 * (the conversation view polls while it is not). If the stream is refused (not linked, signed out) the
 * portal simply keeps working with ordinary requests.
 */
export function usePortalRealtime(slug: string, enabled = true): boolean {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled || typeof EventSource === "undefined") return;
    const source = new EventSource(portalApi(slug, "/events"));
    let connectedBefore = false;
    const refresh = () => void queryClient.invalidateQueries({ queryKey: portalKeys.all(slug) });

    source.addEventListener("ready", () => {
      setLive(true);
      if (connectedBefore) refresh();
      connectedBefore = true;
    });
    source.onerror = () => setLive(false);
    for (const type of EVENT_TYPES) source.addEventListener(type, refresh);
    return () => source.close();
  }, [queryClient, slug, enabled]);

  return live;
}
