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

const SPACETIMEDB_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI!;
const SPACETIMEDB_DB_NAME = process.env.NEXT_PUBLIC_SPACETIMEDB_DB_NAME!;
export const LOCAL_STORAGE_TOKEN_KEY = "pear_spacetimedb_token";

/** Removes the persisted SpacetimeDB identity token so the next load gets a fresh anonymous identity. */
export function clearSavedToken() {
  if (typeof window !== "undefined") {
    localStorage.removeItem(LOCAL_STORAGE_TOKEN_KEY);
  }
}

/**
 * Builds a DbConnectionBuilder configured for the Pear workspace.
 * Pass an OIDC id_token to authenticate via OIDC; omit for native/anonymous auth
 * (falls back to the locally-persisted SpacetimeDB identity token).
 */
export function buildConnectionBuilder(oidcToken?: string) {
  const savedToken =
    typeof window !== "undefined"
      ? (localStorage.getItem(LOCAL_STORAGE_TOKEN_KEY) ?? undefined)
      : undefined;

  const token = oidcToken ?? savedToken;

  return DbConnection.builder()
    .withUri(SPACETIMEDB_URI)
    .withDatabaseName(SPACETIMEDB_DB_NAME)
    .withToken(token)
    .onConnect((conn, identity, newToken) => {
      console.log("[SpacetimeDB] Connected, identity:", identity.toHexString());
      if (typeof window !== "undefined") {
        localStorage.setItem(LOCAL_STORAGE_TOKEN_KEY, newToken);
      }
      conn.subscriptionBuilder().subscribeToAllTables();
      console.log("[SpacetimeDB] subscribeToAllTables called");
    })
    .onConnectError((_ctx, error) => {
      console.error("[SpacetimeDB] Connection error:", error);
      // If the saved token is rejected (e.g. connecting to a different SpacetimeDB
      // instance than the one that issued it), clear the stale token and reload so
      // the SDK creates a fresh anonymous identity instead of retrying the bad token.
      const msg = error instanceof Error ? error.message : String(error);
      if (
        typeof window !== "undefined" &&
        (msg.includes("Failed to verify token") || msg.includes("Unauthorized"))
      ) {
        console.warn("[SpacetimeDB] Stale token rejected — clearing and reloading");
        clearSavedToken();
        window.location.reload();
      }
    })
    .onDisconnect((_ctx, error) => {
      console.warn("[SpacetimeDB] Disconnected", error ?? "");
    });
}
