"use client";

import {
  createContext,
  useContext,
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
  const value: PulpContextValue = {
    tree,
    config,
    ...mutations,
  };
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
