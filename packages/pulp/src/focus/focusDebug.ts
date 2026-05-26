import type { BlockId } from "../types";

/**
 * Insert-focus trace logging — off by default.
 * Enable in the browser console: `localStorage.setItem('pulp:focus', '1')`
 */
export function isFocusDebugEnabled(): boolean {
  if (typeof localStorage === "undefined") return false;
  return localStorage.getItem("pulp:focus") === "1";
}

export function idStr(id: BlockId | null | undefined): string {
  if (id == null) return "null";
  return id.toString();
}

export function focusDebug(
  msg: string,
  data?: Record<string, unknown>,
): void {
  if (!isFocusDebugEnabled() || typeof console === "undefined") return;
  if (data !== undefined) console.log(`[pulp/focus] ${msg}`, data);
  else console.log(`[pulp/focus] ${msg}`);
}
