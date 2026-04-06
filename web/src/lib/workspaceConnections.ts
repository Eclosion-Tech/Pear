"use client";

/** Persisted workspace list and active id (localStorage). */

export type WorkspaceConnection = {
  id: string;
  name: string;
  /** WebSocket target: `ws://` / `wss://` URL, or bare `host`, `host:port`, or IP — normalized on connect. Empty = env or same host as the web app. */
  wsUri: string;
  dbName: string;
};

const STORAGE_KEY = "pear_workspaces_v1";
const ACTIVE_KEY = "pear_active_workspace_id";

const LEGACY_TOKEN_KEY = "pear_spacetimedb_token";

export function tokenStorageKey(connectionId: string): string {
  return `pear_spacetimedb_token__${connectionId}`;
}

function defaultWsUriFromEnv(): string {
  return process.env.NEXT_PUBLIC_SPACETIMEDB_URI?.trim() ?? "";
}

function defaultDbNameFromEnv(): string {
  return process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME?.trim() || "pear-dev";
}

/** Same host WebSocket as the page (when env URI is unset). */
export function getSameHostSpacetimeUri(): string {
  if (typeof window === "undefined") return "ws://localhost:3000";
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProtocol}//${window.location.host}`;
}

/**
 * SpacetimeDB's client parses the URI with `new URL()` — a bare host or IP
 * (e.g. `100.64.0.2` or `host:3000`) is invalid. Ensure `ws://` or `wss://`.
 */
export function ensureWebSocketUri(uri: string): string {
  const t = uri.trim();
  if (!t) return t;
  if (/^wss?:\/\//i.test(t)) return t;
  if (/^https:\/\//i.test(t)) return `wss://${t.slice("https://".length)}`;
  if (/^http:\/\//i.test(t)) return `ws://${t.slice("http://".length)}`;
  return `ws://${t}`;
}

/** Resolve stored wsUri: empty means env or same-host. */
export function resolveWorkspaceWsUri(stored: string | undefined): string {
  const t = (stored ?? "").trim();
  if (t) return ensureWebSocketUri(t);
  const env = defaultWsUriFromEnv();
  if (env) return ensureWebSocketUri(env);
  return getSameHostSpacetimeUri();
}

export function resolveWorkspaceDbName(stored: string | undefined): string {
  const t = (stored ?? "").trim();
  return t || defaultDbNameFromEnv();
}

/** After `ensureWebSocketUri` / `resolveWorkspaceWsUri` — must be a real `ws:` / `wss:` URL for the SDK. */
export function validateResolvedSpacetimeUri(
  resolvedUri: string
): { ok: true } | { ok: false; message: string } {
  const t = resolvedUri.trim();
  if (!t) {
    return { ok: false, message: "Server address is empty." };
  }
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false, message: "That doesn’t look like a valid server address." };
  }
  if (u.protocol !== "ws:" && u.protocol !== "wss:") {
    return { ok: false, message: "Use a WebSocket URL (ws:// or wss://), or a host name with an optional port." };
  }
  if (!u.hostname) {
    return { ok: false, message: "Missing host in the address." };
  }
  return { ok: true };
}

/** For UI: null if this workspace can be used to build a connection URL. */
export function getWorkspaceUriValidationError(w: WorkspaceConnection): string | null {
  const resolved = resolveWorkspaceWsUri(w.wsUri);
  const v = validateResolvedSpacetimeUri(resolved);
  return v.ok ? null : v.message;
}

function newId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return `ws-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultWorkspaceList(): WorkspaceConnection[] {
  return [
    {
      id: newId(),
      name: "Default",
      wsUri: defaultWsUriFromEnv(),
      dbName: defaultDbNameFromEnv(),
    },
  ];
}

/**
 * Load workspaces from localStorage, creating a default entry and migrating the
 * legacy global token key on first run.
 */
export function loadWorkspaces(): { list: WorkspaceConnection[]; activeId: string } {
  if (typeof window === "undefined") {
    const list = defaultWorkspaceList();
    return { list, activeId: list[0].id };
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let list: WorkspaceConnection[] = raw ? (JSON.parse(raw) as WorkspaceConnection[]) : [];

    if (!Array.isArray(list) || list.length === 0) {
      list = defaultWorkspaceList();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      const legacy = localStorage.getItem(LEGACY_TOKEN_KEY);
      const firstId = list[0].id;
      if (legacy && !localStorage.getItem(tokenStorageKey(firstId))) {
        localStorage.setItem(tokenStorageKey(firstId), legacy);
      }
    }

    let activeId = localStorage.getItem(ACTIVE_KEY);
    if (!activeId || !list.some((w) => w.id === activeId)) {
      activeId = list[0].id;
      localStorage.setItem(ACTIVE_KEY, activeId);
    }

    return { list, activeId };
  } catch {
    const list = defaultWorkspaceList();
    return { list, activeId: list[0].id };
  }
}

export function saveWorkspaces(list: WorkspaceConnection[], activeId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  localStorage.setItem(ACTIVE_KEY, activeId);
}

export function setActiveWorkspaceId(activeId: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(ACTIVE_KEY, activeId);
}

export function peekActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}
