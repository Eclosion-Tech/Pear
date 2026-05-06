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

/**
 * Decode `Option<string>` / optional string columns from subscribed rows. The
 * generated TS type is often `string | undefined`, while reducer args use a
 * tagged shape — handle both at runtime so builds stay compatible.
 */
export function optionStringFromRow(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object" && v !== null && "tag" in v) {
    const o = v as { tag: string; value?: string };
    if (o.tag === "none") return "";
    if (o.tag === "some" && o.value != null) return o.value;
  }
  return "";
}

/** Same as {@link optionStringFromRow} but `""` → `null` for JSON patches. */
export function optionStringOrNullForHost(v: unknown): string | null {
  const s = optionStringFromRow(v);
  return s === "" ? null : s;
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
 *
 * @param onOidcExpired - Called when the connection is rejected due to an expired/invalid OIDC
 *   token. In OIDC deployments, pass `() => auth.signinSilent()` so the library fetches a fresh
 *   id_token; the resulting state update will re-trigger this builder with the new token. Falls
 *   back to clearing the saved token + full page reload when omitted or when silent renew fails.
 */
export function buildConnectionBuilder(
  oidcToken: string | undefined,
  workspace: WorkspaceConnection,
  onOidcExpired?: () => Promise<unknown> | void,
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

  const handleAuthError = () => {
    if (typeof window === "undefined") return;
    if (onOidcExpired) {
      console.info("[SpacetimeDB] Token rejected — attempting OIDC silent renew");
      Promise.resolve(onOidcExpired()).catch(() => {
        console.warn("[SpacetimeDB] Silent renew failed — clearing token and reloading");
        clearSavedToken(workspace.id);
        window.location.reload();
      });
    } else {
      console.warn("[SpacetimeDB] Stale token rejected — clearing and reloading");
      clearSavedToken(workspace.id);
      window.location.reload();
    }
  };

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
        if (msg.includes("Failed to verify token") || msg.includes("Unauthorized")) {
          handleAuthError();
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
