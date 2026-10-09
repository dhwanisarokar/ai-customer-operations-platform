"use client";

import { useEffect, useRef, useState } from "react";

export type RealtimeStatus = "connecting" | "connected" | "reconnecting";
export type RealtimeHint = { type: string; conversationId?: string };

/** Splits an SSE text buffer into complete messages and the unfinished rest. */
export function parseSseBuffer(buffer: string): {
  messages: { event: string; data: string }[];
  rest: string;
} {
  const parts = buffer.split("\n\n");
  const rest = parts.pop() ?? "";
  const messages: { event: string; data: string }[] = [];
  for (const part of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of part.split("\n")) {
      if (line.startsWith(":") || line === "") continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length > 0 || event === "ready") messages.push({ event, data: data.join("\n") });
  }
  return { messages, rest };
}

export function backoffDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.min(attempt, 4));
}

/**
 * Realtime for the visitor. Uses fetch (not EventSource) because the visitor authenticates with an
 * Authorization header. Events are hints: `onHint` should refetch. After every reconnect `onReconnect`
 * runs so nothing missed while offline stays missing (the API is the source of truth). While the
 * stream is not connected the caller falls back to polling (see `status`).
 */
export function useWidgetRealtime(options: {
  enabled: boolean;
  getToken: () => string | null;
  onHint: (hint: RealtimeHint) => void;
  onReconnect: () => void;
  /** Changes when the visitor session is replaced, so the stream reconnects to the new session. */
  sessionKey?: string;
  url?: string;
}) {
  const [status, setStatus] = useState<RealtimeStatus>("connecting");
  const handlers = useRef(options);
  useEffect(() => {
    handlers.current = options;
  });

  const { enabled, sessionKey, url = "/api/widget/events" } = options;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let attempt = 0;
    let connectedBefore = false;

    async function loop() {
      while (!controller.signal.aborted) {
        try {
          const token = handlers.current.getToken();
          if (!token) throw new Error("no session");
          const response = await fetch(url, {
            headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok || !response.body) throw new Error(`status ${response.status}`);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
            const parsed = parseSseBuffer(buffer);
            buffer = parsed.rest;
            for (const message of parsed.messages) {
              if (message.event === "ready") {
                attempt = 0;
                setStatus("connected");
                if (connectedBefore) handlers.current.onReconnect();
                connectedBefore = true;
              } else {
                try {
                  handlers.current.onHint(JSON.parse(message.data) as RealtimeHint);
                } catch {
                  handlers.current.onHint({ type: message.event });
                }
              }
            }
          }
        } catch {
          if (controller.signal.aborted) return;
        }
        if (controller.signal.aborted) return;
        setStatus("reconnecting");
        await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt++)));
      }
    }
    void loop();
    return () => controller.abort();
  }, [enabled, url, sessionKey]);

  return status;
}
