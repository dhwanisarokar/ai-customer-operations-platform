import { QueryClient } from "@tanstack/react-query";
import { render, renderHook, type RenderHookOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { vi } from "vitest";
import { QueryProvider } from "@/lib/query/query-provider";

export const TEST_ORG = "org-test";

/**
 * A QueryClient for ONE test: no retries, no cache lifetime surprises, and never the production
 * singleton. Tests must not share server state.
 */
export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function queryWrapper(client: QueryClient, organizationId: string | null = TEST_ORG) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryProvider client={client} organizationId={organizationId}>
        {children}
      </QueryProvider>
    );
  };
}

export function renderHookWithQuery<TProps, TResult>(
  hook: (props: TProps) => TResult,
  options: {
    client?: QueryClient;
    organizationId?: string | null;
    initialProps?: TProps;
  } = {},
) {
  const client = options.client ?? createTestQueryClient();
  const hookOptions: RenderHookOptions<TProps> = {
    wrapper: queryWrapper(
      client,
      options.organizationId === undefined ? TEST_ORG : options.organizationId,
    ),
    initialProps: options.initialProps,
  };
  return { client, ...renderHook(hook, hookOptions) };
}

export function renderWithQuery(
  ui: ReactElement,
  options: { client?: QueryClient; organizationId?: string | null } = {},
) {
  const client = options.client ?? createTestQueryClient();
  const Wrapper = queryWrapper(
    client,
    options.organizationId === undefined ? TEST_ORG : options.organizationId,
  );
  return { client, ...render(ui, { wrapper: Wrapper }) };
}

// ---- fetch mocking -------------------------------------------------------------------------

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export const noContent = () => new Response(null, { status: 204 });

export const apiError = (status: number, code: string, message: string) =>
  json(status, { error: { code, message, requestId: "test" } });

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Installs a fetch mock routed by "METHOD /path-prefix". The first matching route wins; calls are
 * recorded for assertions. Unmatched requests fail the test loudly.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = Object.keys(routes).find((route) => {
      const [m, ...rest] = route.split(" ");
      return m === method && url.startsWith(rest.join(" "));
    });
    if (!key) throw new Error(`Unmocked request: ${method} ${url}`);
    return routes[key](url, init);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    fetchMock,
    count: (method: string, prefix: string) =>
      calls.filter((call) => call.method === method && call.url.startsWith(prefix)).length,
  };
}
