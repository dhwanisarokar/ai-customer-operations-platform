"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState, useSyncExternalStore } from "react";
import { makeQueryClient } from "@/lib/query/query-client";
import { WidgetSessionProvider } from "../hooks/use-widget-session";
import { ChatWidget } from "./chat-widget";

/**
 * The page inside the iframe. It has its own query client and session provider: it shares nothing
 * with the dashboard (a visitor is not a user, and the key is public).
 */
export function WidgetApp({ widgetKey, embedOrigin }: { widgetKey: string; embedOrigin?: string }) {
  const [client] = useState(() => makeQueryClient());
  // Same value on the server and during hydration (false), then the real one: no hydration mismatch.
  const embedded = useSyncExternalStore(
    () => () => {},
    () => window.parent !== window,
    () => false,
  );
  return (
    <QueryClientProvider client={client}>
      <WidgetSessionProvider widgetKey={widgetKey} embedOrigin={embedOrigin}>
        <ChatWidget
          onClose={
            embedded ? () => window.parent.postMessage({ type: "cw:close" }, "*") : undefined
          }
        />
      </WidgetSessionProvider>
    </QueryClientProvider>
  );
}
