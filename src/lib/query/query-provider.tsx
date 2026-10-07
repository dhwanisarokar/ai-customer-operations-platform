"use client";

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { lazy, Suspense, createContext, useContext, useState, type ReactNode } from "react";
import { getQueryClient } from "./query-client";

const OrganizationScopeContext = createContext<string | null>(null);

/**
 * The active organization id, used ONLY to namespace cache keys, so switching organizations can
 * never show another organization's cached data. It is not an authorization input: it comes from
 * the server-verified session (dashboard layout), and every API call is authorized server-side.
 */
export function useOrganizationScope(): string | null {
  return useContext(OrganizationScopeContext);
}

// Devtools exist only in development builds; the import is dead-code-eliminated in production.
const Devtools =
  process.env.NODE_ENV === "development"
    ? lazy(() =>
        import("@tanstack/react-query-devtools").then((module) => ({
          default: module.ReactQueryDevtools,
        })),
      )
    : null;

export function QueryProvider({
  organizationId,
  children,
  client,
}: {
  organizationId: string | null;
  children: ReactNode;
  /** Tests pass an isolated client; the app uses the browser singleton. */
  client?: QueryClient;
}) {
  const [queryClient] = useState(() => client ?? getQueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <OrganizationScopeContext.Provider value={organizationId}>
        {children}
        {Devtools ? (
          <Suspense fallback={null}>
            <Devtools initialIsOpen={false} />
          </Suspense>
        ) : null}
      </OrganizationScopeContext.Provider>
    </QueryClientProvider>
  );
}
