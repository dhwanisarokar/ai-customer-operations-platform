"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useSyncExternalStore, type CSSProperties } from "react";
import { Button } from "@/components/ui/button";
import { useWidgetRealtime } from "../hooks/use-widget-realtime";
import { useWidgetSession } from "../hooks/use-widget-session";
import {
  initialView,
  widgetQueryKeys,
  type ConversationsResponse,
  type WidgetView,
} from "../types";
import { ConversationView } from "./conversation-view";
import { NewConversationView } from "./new-conversation-view";
import { WelcomeView } from "./welcome-view";

export { widgetQueryKeys };

const POLL_WHEN_DISCONNECTED_MS = 8000;

function subscribeOnline(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function useOnline() {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

/**
 * The open widget. Local UI state is ONE value, `view` (WELCOME, NEW_CONVERSATION or
 * ACTIVE_CONVERSATION); server state (conversations, messages) lives in TanStack Query. Each screen is
 * its own component: nothing here toggles one layout with conditional CSS.
 */
export function ChatWidget({ onClose }: { onClose?: () => void }) {
  const { state, retry, api, getToken } = useWidgetSession();
  const queryClient = useQueryClient();
  const online = useOnline();
  const ready = state.status === "ready";

  const realtime = useWidgetRealtime({
    enabled: ready,
    sessionKey: state.status === "ready" ? state.sessionId : undefined,
    getToken,
    onHint: (hint) => {
      void queryClient.invalidateQueries({ queryKey: widgetQueryKeys.conversations });
      if (hint.conversationId) {
        void queryClient.invalidateQueries({
          queryKey: widgetQueryKeys.conversation(hint.conversationId),
        });
      }
    },
    onReconnect: () => void queryClient.invalidateQueries({ queryKey: widgetQueryKeys.all }),
  });
  const live = realtime === "connected";

  const list = useQuery({
    queryKey: widgetQueryKeys.conversations,
    queryFn: ({ signal }) => api<ConversationsResponse>("/api/widget/conversations", { signal }),
    enabled: ready,
    refetchInterval: live ? false : POLL_WHEN_DISCONNECTED_MS,
  });
  const conversations = list.data?.conversations ?? [];

  // `null` = the visitor has not navigated yet: show what fits their existing conversations.
  const [chosen, setChosen] = useState<WidgetView | null>(null);
  const view: WidgetView | null = chosen ?? (list.data ? initialView(conversations) : null);
  const canGoBack =
    view?.name === "ACTIVE_CONVERSATION" ||
    (view?.name === "NEW_CONVERSATION" && conversations.length > 0);

  const accent = state.status === "ready" ? state.config.accentColor : null;
  const style = accent ? ({ "--primary": accent } as CSSProperties) : undefined;
  const title = state.status === "ready" ? state.config.displayName : "Chat";

  return (
    <div
      className="bg-background text-foreground flex h-dvh min-h-0 flex-col overflow-hidden"
      style={style}
    >
      <header className="border-border bg-primary text-primary-foreground flex shrink-0 items-center gap-2 border-b px-3 py-3">
        {canGoBack ? (
          <button
            type="button"
            onClick={() => setChosen({ name: "WELCOME" })}
            aria-label="Back to your chats"
            className="rounded px-2 py-1 text-sm hover:bg-white/15"
          >
            ←
          </button>
        ) : null}
        <h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{title}</h1>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="rounded px-2 py-1 text-sm hover:bg-white/15"
          >
            ✕
          </button>
        ) : null}
      </header>

      {!online ? (
        <p role="status" className="bg-muted text-muted-foreground shrink-0 px-3 py-1.5 text-xs">
          You are offline. Messages will send when you are back online.
        </p>
      ) : ready && !live ? (
        <p role="status" className="bg-muted text-muted-foreground shrink-0 px-3 py-1.5 text-xs">
          Reconnecting…
        </p>
      ) : null}

      {state.status === "loading" ? (
        <p className="text-muted-foreground p-4 text-sm">Connecting…</p>
      ) : state.status === "unavailable" ? (
        <p className="text-muted-foreground p-4 text-sm">
          Chat is not available right now. Please try again later.
        </p>
      ) : state.status === "error" ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <p className="text-sm">We could not start the chat.</p>
          <Button size="sm" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : list.isError ? (
        <div className="flex flex-col items-start gap-3 p-4">
          <p className="text-sm">We could not load your chats.</p>
          <Button size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : view === null ? (
        <p className="text-muted-foreground p-4 text-sm">Loading your chats…</p>
      ) : view.name === "ACTIVE_CONVERSATION" ? (
        <ConversationView
          key={view.conversationId}
          conversationId={view.conversationId}
          api={api}
          live={live}
        />
      ) : view.name === "NEW_CONVERSATION" ? (
        <NewConversationView
          api={api}
          welcome={state.config.welcomeMessage}
          onCreated={(conversationId) => setChosen({ name: "ACTIVE_CONVERSATION", conversationId })}
        />
      ) : (
        <WelcomeView
          welcome={state.config.welcomeMessage}
          conversations={conversations}
          onOpen={(conversationId) => setChosen({ name: "ACTIVE_CONVERSATION", conversationId })}
          onNew={() => setChosen({ name: "NEW_CONVERSATION" })}
        />
      )}
    </div>
  );
}
