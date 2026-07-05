"use client";

/**
 * Bootstrap the active workspace from URL query params:
 *   ?ws=ws://127.0.0.1:3300&db=pear-local&wsname=Local%20workspace
 *
 * Used by the desktop launcher's local-workspace mode (and handy for any
 * deep link into a self-hosted instance). Runs SYNCHRONOUSLY during render —
 * before any provider's mount effect reads localStorage — via the same
 * `ensureCloudWorkspaceActive` contract Pear Cloud uses. Idempotent, so the
 * render-phase call is safe under StrictMode double-render.
 */

import { ensureCloudWorkspaceActive } from "@/src/lib/workspaceConnections";

let applied = false;

export function WorkspaceQueryBootstrap() {
  if (typeof window !== "undefined" && !applied) {
    applied = true;
    const params = new URLSearchParams(window.location.search);
    const ws = params.get("ws");
    const db = params.get("db");
    if (ws && db) {
      ensureCloudWorkspaceActive({
        name: params.get("wsname") ?? undefined,
        wsUri: ws,
        dbName: db,
      });
    }
  }
  return null;
}
