"use client";

import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import type { PulpContextValue, PulpMutations, PulpConfig, BlockTree } from "../types";

const PulpContext = createContext<PulpContextValue | null>(null);

export function PulpProvider({
  tree,
  config,
  mutations,
  children,
}: {
  tree: BlockTree;
  config: PulpConfig;
  mutations: PulpMutations;
  children: ReactNode;
}) {
  // Memoized so a host re-render with unchanged inputs doesn't publish a new
  // context object — an inline literal here re-renders every usePulp()
  // consumer (every BlockNodeView) and defeats their memo().
  const value: PulpContextValue = useMemo(
    () => ({
      tree,
      config,
      ...mutations,
    }),
    [tree, config, mutations],
  );
  return (
    <PulpContext.Provider value={value}>{children}</PulpContext.Provider>
  );
}

export function usePulp(): PulpContextValue {
  const ctx = useContext(PulpContext);
  if (!ctx) {
    throw new Error(
      "[@eclosion-tech/pulp] usePulp() must be used within <PulpProvider>",
    );
  }
  return ctx;
}

/** Optional consumer — returns null outside a provider (storybook / tests). */
export function usePulpOptional(): PulpContextValue | null {
  return useContext(PulpContext);
}
