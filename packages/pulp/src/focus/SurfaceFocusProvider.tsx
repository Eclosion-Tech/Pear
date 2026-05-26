"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  SurfaceFocusCoordinator,
  NOOP_SURFACE_FOCUS,
  type SurfaceFocusValue,
} from "./SurfaceFocusCoordinator";

const SurfaceFocusContext = createContext<SurfaceFocusValue | null>(null);

export function SurfaceFocusProvider({
  coordinator,
  children,
}: {
  coordinator: SurfaceFocusCoordinator;
  children: ReactNode;
}) {
  const value = useMemo(() => coordinator.getApi(), [coordinator]);
  return (
    <SurfaceFocusContext.Provider value={value}>
      {children}
    </SurfaceFocusContext.Provider>
  );
}

export function useSurfaceFocus(): SurfaceFocusValue {
  const ctx = useContext(SurfaceFocusContext);
  if (ctx) return ctx;
  return NOOP_SURFACE_FOCUS;
}

export { SurfaceFocusCoordinator } from "./SurfaceFocusCoordinator";
export type { SurfaceFocusValue, ArmForInsertOpts, FocusPlacement } from "./SurfaceFocusCoordinator";
