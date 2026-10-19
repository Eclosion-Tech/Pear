"use client";

import { useEffect, useState } from "react";

export const TRELLIS_GENERATED_UI_KEY = "pear:trellis-generated-ui";
const BUILD_DEFAULT = process.env.NEXT_PUBLIC_PEAR_TRELLIS_GENERATED_UI === "1";

export function readTrellisGeneratedUiFlag(): boolean {
  if (typeof window === "undefined") return BUILD_DEFAULT;
  try {
    const value = window.localStorage.getItem(TRELLIS_GENERATED_UI_KEY);
    if (value === "1") return true;
    if (value === "0") return false;
  } catch {
    /* Storage may be disabled. */
  }
  return BUILD_DEFAULT;
}

/** Match the server's build default until hydration finishes. */
export function useTrellisGeneratedUiFlag(): boolean {
  const [enabled, setEnabled] = useState(BUILD_DEFAULT);
  useEffect(() => {
    setEnabled(readTrellisGeneratedUiFlag());
  }, []);
  return enabled;
}
