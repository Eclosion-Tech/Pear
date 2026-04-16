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

/**
 * Pear Cloud: ensure the workspace identified by (wsUri, dbName) is the
 * active entry in localStorage. Matches existing entries by identity
 * (wsUri + dbName), inserting a new one only when absent.
 *
 * Why this exists: `WorkspaceProvider` is a standalone-Pear concept that
 * treats localStorage as the source of truth for the "active" workspace.
 * In Pear Cloud the URL slug is the real source of truth, and the same
 * browser profile may see many accounts / workspaces. Without this sync,
 * `activeWorkspace.dbName` (and anything derived from it — notably
 * `idbNamespace` used for Yjs IDB persistence keys) can point at a
 * previously-visited workspace, causing page-N in workspace B to
 * hydrate from workspace A's IndexedDB (cross-workspace data leak).
 *
 * Safe to call on every render; pure localStorage mutation, no React
 * state involvement. Must be called SYNCHRONOUSLY before
 * `WorkspaceProvider` mounts (which reads localStorage once in an
 * effect on first render).
 */
export function ensureCloudWorkspaceActive(params: {
  name?: string;
  wsUri: string;
  dbName: string;
}): void {
  if (typeof window === "undefined") return;

  const wsUri = params.wsUri.trim();
  const dbName = params.dbName.trim();
  if (!dbName) return;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    let list: WorkspaceConnection[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (Array.isArray(parsed)) list = parsed as WorkspaceConnection[];
      } catch {
        list = [];
      }
    }

    // Match on identity: same SpacetimeDB target, same module name.
    let match = list.find((w) => w.wsUri === wsUri && w.dbName === dbName);
    if (!match) {
      match = {
        id: newId(),
        name: params.name ?? dbName,
        wsUri,
        dbName,
      };
      list = [...list, match];
    } else if (params.name && match.name !== params.name) {
      // Keep the display name in sync with the URL slug without
      // disturbing the stored id.
      list = list.map((w) => (w.id === match!.id ? { ...w, name: params.name! } : w));
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    localStorage.setItem(ACTIVE_KEY, match.id);
  } catch {
    // localStorage unavailable (private mode etc.) — nothing to do.
  }
}

/**
 * Purge all Pear-owned browser storage (localStorage + IndexedDB). Intended
 * for logout / account-switch, so the next user of this browser profile
 * doesn't inherit the previous session's workspace list, tokens, or Yjs
 * editor IDB snapshots.
 *
 * This is best-effort: IDB deletion is async and can be blocked if other
 * tabs hold the database open. We fire-and-forget and let the next user's
 * login recreate what's needed.
 */
export async function purgePearBrowserState(): Promise<void> {
  if (typeof window === "undefined") return;

  // 1. localStorage — everything under the `pear_` prefix.
  try {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith("pear_")) keysToDelete.push(k);
    }
    for (const k of keysToDelete) localStorage.removeItem(k);
  } catch {
    // ignore
  }

  // 2. IndexedDB — every `pear_idb_*` database (Yjs persistence).
  try {
    // indexedDB.databases() is supported in Chromium and recent Firefox.
    const anyIdb = indexedDB as unknown as {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    if (anyIdb.databases) {
      const dbs = await anyIdb.databases();
      await Promise.all(
        dbs
          .map((d) => d.name)
          .filter((n): n is string => typeof n === "string" && n.startsWith("pear_idb_"))
          .map(
            (name) =>
              new Promise<void>((resolve) => {
                const req = indexedDB.deleteDatabase(name);
                req.onsuccess = () => resolve();
                req.onerror = () => resolve();
                req.onblocked = () => resolve();
              })
          )
      );
    }
  } catch {
    // ignore
  }
}

export function peekActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACTIVE_KEY);
}
