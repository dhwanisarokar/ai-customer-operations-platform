"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { apiRequest } from "@/lib/api-client";

/**
 * Marks the open conversation as read for the current member. Reading is a deliberate user action
 * (opening it), so it is a POST from the client rather than a side effect of rendering a page.
 * Refreshes once afterwards so the list's unread dot clears.
 */
export function MarkRead({ conversationId, unread }: { conversationId: string; unread: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!unread) return;
    let cancelled = false;
    void apiRequest(`/api/conversations/${conversationId}/read`, { method: "POST" }).then(
      (result) => {
        if (result.ok && !cancelled) router.refresh();
      },
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId, unread, router]);

  return null;
}
