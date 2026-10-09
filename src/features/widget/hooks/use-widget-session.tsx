"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, fetchJson } from "@/lib/api-client";

export type WidgetConfig = {
  displayName: string;
  welcomeMessage: string;
  accentColor: string | null;
};

type SessionResponse = {
  token: string | null;
  session: { id: string; expiresAt: string };
  widget: WidgetConfig;
};

export type SessionState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "error"; message: string }
  | { status: "ready"; config: WidgetConfig; sessionId: string };

type Context = {
  state: SessionState;
  retry: () => void;
  /** Authenticated call to the PUBLIC widget API. Re-opens the session once if it has expired. */
  api: <T>(
    path: string,
    options?: { method?: string; body?: unknown; signal?: AbortSignal },
  ) => Promise<T>;
  /** Current token for the realtime connection (null until the session is ready). */
  getToken: () => string | null;
};

const WidgetSessionContext = createContext<Context | null>(null);

export function useWidgetSession(): Context {
  const context = useContext(WidgetSessionContext);
  if (!context) throw new Error("useWidgetSession must be used inside WidgetSessionProvider");
  return context;
}

const storageKey = (key: string) => `cw:${key}`;

function readToken(key: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(key));
  } catch {
    return null; // private mode / blocked storage: the session simply lasts for this page view
  }
}
function writeToken(key: string, token: string | null) {
  try {
    if (token) window.localStorage.setItem(storageKey(key), token);
    else window.localStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

/**
 * Owns the visitor session: starts or resumes it from the PUBLIC widget key, keeps the bearer token
 * (localStorage, scoped per widget key) and transparently starts a new session when the server says
 * the old one expired. The organization is never known to the client.
 */
export function WidgetSessionProvider({
  widgetKey,
  embedOrigin,
  children,
}: {
  widgetKey: string;
  embedOrigin?: string;
  children: ReactNode;
}) {
  const [state, setState] = useState<SessionState>({ status: "loading" });
  const token = useRef<string | null>(null);
  const opening = useRef<Promise<void> | null>(null);

  const openSession = useCallback(async () => {
    try {
      const response = await fetchJson<SessionResponse>("/api/widget/session", {
        method: "POST",
        body: { key: widgetKey, ...(embedOrigin ? { embedOrigin } : {}) },
        headers: token.current ? { authorization: `Bearer ${token.current}` } : undefined,
      });
      if (response.token) {
        token.current = response.token;
        writeToken(widgetKey, response.token);
      }
      setState({ status: "ready", config: response.widget, sessionId: response.session.id });
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
        setState({ status: "unavailable" });
      } else {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Chat is unavailable.",
        });
      }
    }
  }, [widgetKey, embedOrigin]);

  // ONE session open at a time. Concurrent callers (React StrictMode runs effects twice in
  // development, a 401 can race the first load) share the same request: two opens would create two
  // visitor sessions, and the realtime stream could listen to a different one than the API calls use.
  const open = useCallback(() => {
    opening.current ??= openSession().finally(() => {
      opening.current = null;
    });
    return opening.current;
  }, [openSession]);

  const start = useCallback(() => {
    setState({ status: "loading" });
    token.current = readToken(widgetKey);
    void open();
  }, [open, widgetKey]);

  useEffect(() => {
    // The state starts as "loading", so the first open only needs to read the stored token.
    token.current = readToken(widgetKey);
    void open();
  }, [open, widgetKey]);

  const api = useCallback<Context["api"]>(
    async (path, options = {}) => {
      const run = () =>
        fetchJson<never>(path, {
          ...options,
          headers: token.current ? { authorization: `Bearer ${token.current}` } : undefined,
        });
      try {
        return await run();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // The session expired or was revoked: start a fresh one and retry once.
          token.current = null;
          writeToken(widgetKey, null);
          await open();
          return run();
        }
        throw error;
      }
    },
    [open, widgetKey],
  );

  const value: Context = { state, retry: start, api, getToken: () => token.current };
  return <WidgetSessionContext.Provider value={value}>{children}</WidgetSessionContext.Provider>;
}
