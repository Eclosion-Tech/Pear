"use client";

import { useCallback, useEffect, useState } from "react";
import type { CompositionLayout } from "@eclosion-tech/pulp";

/** A reader's page layout is local UI state, never a shared document mutation. */
export function usePageCompositionLayout(namespace: string, pageId: bigint) {
  const key = `pear:${namespace}:page:${pageId}:composition-layout`;
  const [saved, setSaved] = useState<{ key: string; layout: CompositionLayout } | null>(null);
  useEffect(() => {
    let layout: CompositionLayout = "structured";
    try { if (localStorage.getItem(key) === "continuous") layout = "continuous"; } catch { /* Storage may be unavailable. */ }
    setSaved({ key, layout });
  }, [key]);
  const setLayout = useCallback((layout: CompositionLayout) => {
    setSaved({ key, layout });
    try { localStorage.setItem(key, layout); } catch { /* The current view still works. */ }
  }, [key]);
  return [saved?.key === key ? saved.layout : "structured", setLayout] as const;
}
