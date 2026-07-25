"use client";

import { useEffect, useState } from "react";

/**
 * M3 flag: render the sidebar page tree through the repeater runtime instead of
 * the bespoke recursive component.
 *
 * **Off by default, and it stays off until the back-out bar is met** (p99
 * delivery-to-paint within 1.5× of bespoke on churn and deep nesting, no
 * remount storms). Missing the bar reverts the flag, not the code.
 *
 * Flagged mode is deliberately **navigate-only**. Virtual nodes are
 * structurally read-only (D2) and prop write-back is deferred to M5 (D6), so
 * drag-to-reorder, inline rename, multi-select, and the context menu are not
 * available on the repeater path. That is a known gap, not a regression to fix
 * here: this flag exists to produce field numbers for the render path, not to
 * replace the sidebar. The ADR's "indistinguishable feel (drag, …)" acceptance
 * cannot be met before M5.
 *
 * Two ways to set it, so the comparison can be made without a rebuild:
 *
 * - build default: `NEXT_PUBLIC_PEAR_REPEATER_SIDEBAR=1`
 * - runtime override, wins over the default:
 *   `localStorage.setItem("pear:repeater-sidebar", "1" | "0")` then reload
 */

const STORAGE_KEY = "pear:repeater-sidebar";

const BUILD_DEFAULT = process.env.NEXT_PUBLIC_PEAR_REPEATER_SIDEBAR === "1";

export function readRepeaterSidebarFlag(): boolean {
  if (typeof window === "undefined") return BUILD_DEFAULT;
  try {
    const override = window.localStorage.getItem(STORAGE_KEY);
    if (override === "1") return true;
    if (override === "0") return false;
  } catch {
    // Private mode / storage disabled — fall through to the build default.
  }
  return BUILD_DEFAULT;
}

/**
 * Read the flag without tripping hydration.
 *
 * The server render has no `localStorage`, so the first client render must
 * match the build default and only then settle to the override.
 *
 * `settled` reports whether that has happened. It matters for measurement:
 * before the override is read, the losing implementation renders once and would
 * otherwise record a cold-start sample it does not own — which is exactly the
 * artifact that produced a meaningless 66× ratio from a single 331 ms sample.
 */
export function useRepeaterSidebarFlagState(): { enabled: boolean; settled: boolean } {
  const [state, setState] = useState({ enabled: BUILD_DEFAULT, settled: false });
  useEffect(() => {
    setState({ enabled: readRepeaterSidebarFlag(), settled: true });
  }, []);
  return state;
}

export function useRepeaterSidebarFlag(): boolean {
  return useRepeaterSidebarFlagState().enabled;
}
