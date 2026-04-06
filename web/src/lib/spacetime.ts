"use client";

// React's development-mode error formatter classifies bigint[] as a "primitive
// array" and calls JSON.stringify() on it, which throws in Firefox/Chrome.
// Adding toJSON makes all BigInt values serialise as their decimal string,
// which is both lossless and safe for any logging / error-description code.
if (typeof BigInt !== "undefined" && !("toJSON" in BigInt.prototype)) {
  Object.defineProperty(BigInt.prototype, "toJSON", {
    value(this: bigint) {
      return this.toString();
    },
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

import { DbConnection } from "@/src/module_bindings";
import {
  resolveWorkspaceDbName,
  resolveWorkspaceWsUri,
  tokenStorageKey,
  validateResolvedSpacetimeUri,
  type WorkspaceConnection,
} from "@/src/lib/workspaceConnections";

const LEGACY_TOKEN_KEY = "pear_spacetimedb_token";

export { tokenStorageKey };
/** @deprecated Use tokenStorageKey(connectionId) */
export const LOCAL_STORAGE_TOKEN_KEY = LEGACY_TOKEN_KEY;

/**
 * A short stable string that uniquely identifies the server+database combination.
 * Pass the workspace's stored wsUri/dbName (may be empty; same resolution as connect).
 */
export function getIdbNamespace(storedWsUri: string, storedDbName: string): string {
  const uri = resolveWorkspaceWsUri(storedWsUri);
  const db = resolveWorkspaceDbName(storedDbName);
  return `pear_idb_${uri}_${db}`;
}

/** @deprecated Use getIdbNamespace(wsUri, dbName) from the active workspace. */
export const idbNamespace = getIdbNamespace(
  process.env.NEXT_PUBLIC_SPACETIMEDB_URI?.trim() ?? "",
  process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME?.trim() || "pear-dev"
);

/** Promisify a single IDBOpenDBRequest from deleteDatabase(). */
function deleteIdb(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      resolve();
    };
  });
}

/**
 * Delete all Pear IndexedDB caches for the current origin.
 * Clears both the current namespace and any legacy `pear-page-*` entries
 * from older naming schemes.
 * Call this from the settings panel after a server reset, then reload.
 */
export async function clearIdbCache(namespace?: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;

  const dbs = await indexedDB.databases();
  const ns = namespace ?? idbNamespace;
  const pearDbs = dbs.filter(
    (db) =>
      db.name?.startsWith(ns) ||
      db.name?.startsWith("pear-page-") ||
      db.name?.startsWith("pear_idb_")
  );

  await Promise.all(pearDbs.map((db) => deleteIdb(db.name!)));
}

/**
 * Delete IndexedDB cache for a single page (Yjs doc for that page).
 * Use when a page is out of sync or after schema changes; then reload.
 */
export async function clearIdbCacheForPage(
  pageId: bigint,
  namespace: string
): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const name = `${namespace}-page-${pageId}`;
  await deleteIdb(name);
}

/** Removes the persisted SpacetimeDB identity token for a workspace. */
export function clearSavedToken(connectionId?: string) {
  if (typeof window === "undefined") return;
  if (connectionId) {
    localStorage.removeItem(tokenStorageKey(connectionId));
  } else {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }
}

/**
 * Builds a DbConnectionBuilder configured for a Pear workspace.
 * Pass an OIDC id_token to authenticate via OIDC; omit for native/anonymous auth
 * (falls back to the locally-persisted SpacetimeDB identity token for that workspace).
 * Returns `null` if the address is invalid or the client cannot construct a connection (never throws).
 */
export function buildConnectionBuilder(
  oidcToken: string | undefined,
  workspace: WorkspaceConnection
): ReturnType<typeof DbConnection.builder> | null {
  const spacetimeUri = resolveWorkspaceWsUri(workspace.wsUri);
  const v = validateResolvedSpacetimeUri(spacetimeUri);
  if (!v.ok) {
    return null;
  }
  const databaseName = resolveWorkspaceDbName(workspace.dbName);
  const tokenKey = tokenStorageKey(workspace.id);
  const savedToken =
    typeof window !== "undefined" ? (localStorage.getItem(tokenKey) ?? undefined) : undefined;

  const token = oidcToken ?? savedToken;

  try {
    return DbConnection.builder()
      .withUri(spacetimeUri)
      .withDatabaseName(databaseName)
      .withToken(token)
      .onConnect((conn, identity, newToken) => {
        console.log("[SpacetimeDB] Connected, identity:", identity.toHexString());
        if (typeof window !== "undefined") {
          localStorage.setItem(tokenKey, newToken);
        }
        conn.subscriptionBuilder().subscribeToAllTables();
      })
      .onConnectError((_ctx, error) => {
        console.error("[SpacetimeDB] Connection error:", error);
        const msg = error instanceof Error ? error.message : String(error);
        if (
          typeof window !== "undefined" &&
          (msg.includes("Failed to verify token") || msg.includes("Unauthorized"))
        ) {
          console.warn("[SpacetimeDB] Stale token rejected — clearing and reloading");
          clearSavedToken(workspace.id);
          window.location.reload();
        }
      })
      .onDisconnect((_ctx, error) => {
        console.warn("[SpacetimeDB] Disconnected", error ?? "");
      });
  } catch (e) {
    console.warn("[SpacetimeDB] Invalid connection settings:", e);
    return null;
  }
}
