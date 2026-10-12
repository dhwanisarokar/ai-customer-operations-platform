"use client";

import { createContext, useContext } from "react";
import { usePortalRealtime } from "./use-portal-realtime";

type PortalInfo = { slug: string; name: string };
type PortalValue = PortalInfo & {
  /** The realtime stream is connected (otherwise views poll). */
  live: boolean;
};

const PortalContext = createContext<PortalValue | null>(null);

/**
 * The portal the page belongs to. The slug only selects the organization in API URLs (the server
 * resolves and verifies everything); it is not an authorization input.
 */
export function PortalInfoProvider({
  info,
  children,
}: {
  info: PortalInfo;
  children: React.ReactNode;
}) {
  const live = usePortalRealtime(info.slug);
  return <PortalContext.Provider value={{ ...info, live }}>{children}</PortalContext.Provider>;
}

export function usePortalInfo(): PortalValue {
  const value = useContext(PortalContext);
  if (!value) throw new Error("usePortalInfo must be used inside PortalInfoProvider");
  return value;
}
