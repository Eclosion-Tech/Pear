"use client";

import { useTable, useReducer } from "spacetimedb/react";
import type { Identity } from "spacetimedb";
import { tables, reducers } from "@/src/module_bindings";

/**
 * Per-human user preference store. Keyed by `identity + key`; values are
 * arbitrary JSON strings the UI parses on read.
 *
 * Phase A introduces preferences keyed under `mention_thread_behavior` and
 * `mention_thread_behavior:ai:<aiUserId>` to drive the @mention resolver.
 * Other UI-local preferences should pick keys with descriptive prefixes
 * (e.g. `sidebar:mode`) to avoid collisions.
 */
export function useUserPreferences() {
  const [prefs] = useTable(tables.user_preference);
  return prefs;
}

export function useMyUserPreference(
  identity: Identity | undefined,
  key: string,
): string | null {
  const prefs = useUserPreferences();
  if (!identity) return null;
  const meHex = identity.toHexString();
  const row = prefs.find(
    (p) => p.identity.toHexString() === meHex && p.key === key,
  );
  return row?.valueJson ?? null;
}

export function useSetUserPreference() {
  return useReducer(reducers.setUserPreference);
}

/**
 * Mention-thread resolver — Phase A "thread behavior hierarchy".
 *
 * Resolution order (most specific wins):
 *   1. Per-AI-user override `mention_thread_behavior:ai:<aiUserId>` for me
 *   2. My global default `mention_thread_behavior`
 *   3. The product default — `continue` if there's an active conversation
 *      for this `(page, ai_user)` pair updated within the recency window,
 *      otherwise `new`.
 *
 * The "in-the-moment" chip described in the doc rev 3 should override 1+2
 * for a single send by passing `chipOverride`.
 */
export type ThreadBehavior = "continue" | "new";
export const MENTION_RECENCY_MS = 30 * 60 * 1000;

export function resolveThreadBehavior(args: {
  global: string | null;
  perAiUser: string | null;
  chipOverride?: ThreadBehavior;
  hasRecentActiveConversation: boolean;
}): ThreadBehavior {
  if (args.chipOverride) return args.chipOverride;
  if (args.perAiUser === "continue" || args.perAiUser === "new") {
    return args.perAiUser;
  }
  if (args.global === "continue" || args.global === "new") {
    return args.global;
  }
  return args.hasRecentActiveConversation ? "continue" : "new";
}
