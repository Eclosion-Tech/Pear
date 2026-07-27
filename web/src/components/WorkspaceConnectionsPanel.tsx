"use client";

import { useRef, useState } from "react";
import { useSpacetimeDB, useReducer } from "spacetimedb/react";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import {
  getWorkspaceUriValidationError,
  resolveWorkspaceDbName,
  resolveWorkspaceWsUri,
  validateResolvedSpacetimeUri,
} from "@/src/lib/workspaceConnections";
import {
  PEAR_SNAPSHOT_FORMAT_V2,
  buildPearSnapshotV2,
  chunkSnapshotV2,
  downloadPearSnapshotJson,
  parsePearSnapshotJson,
  type PearSnapshotV2,
} from "@/src/lib/pearExport";
import { clearIdbCache } from "@/src/lib/spacetime";
import { reducers, tables } from "@/src/module_bindings";

/**
 * Call signatures of the v2 import reducers (single named-args object, like the
 * generated `conn.reducers.*` accessors).
 */
type PearImportV2Reducers = {
  importV2Begin: (args: { headerJson: string }) => Promise<void>;
  importV2Chunk: (args: { seq: number; tableName: string; rowsJson: string }) => Promise<void>;
  importV2Commit: (args: { manifestJson: string }) => Promise<void>;
  importV2Abort: () => Promise<void>;
};

function getImportV2Reducers(conn: unknown): PearImportV2Reducers {
  // TODO(bindings-regen): the import_v2_* reducers are being added to the Rust
  // module concurrently and the generated bindings don't include them yet, so
  // we go through the connection's untyped reducers view. Once `spacetime
  // generate` runs against the new module, replace this cast with the typed
  // `reducers.importV2Begin` etc. accessors (and `useReducer`, mirroring v1).
  const r = (conn as { reducers?: Record<string, unknown> }).reducers as
    | Partial<PearImportV2Reducers>
    | undefined;
  if (
    !r ||
    typeof r.importV2Begin !== "function" ||
    typeof r.importV2Chunk !== "function" ||
    typeof r.importV2Commit !== "function" ||
    typeof r.importV2Abort !== "function"
  ) {
    throw new Error(
      "This workspace's module does not support pear-snapshot-v2 import (import_v2_* reducers missing). Update the module and try again."
    );
  }
  return r as PearImportV2Reducers;
}

/** Best-effort: newest module version recorded in the public migration_state table. */
function readModuleVersion(db: unknown): string | undefined {
  try {
    const table = (db as Record<string, { iter?: () => Iterable<unknown> } | undefined>)[
      "migration_state"
    ];
    if (!table || typeof table.iter !== "function") return undefined;
    let best: string | undefined;
    let bestAt = -1n;
    for (const row of table.iter()) {
      const r = row as {
        moduleVersion?: unknown;
        completedAt?: { microsSinceUnixEpoch?: unknown };
      };
      const at =
        typeof r?.completedAt?.microsSinceUnixEpoch === "bigint"
          ? r.completedAt.microsSinceUnixEpoch
          : 0n;
      if (typeof r?.moduleVersion === "string" && at >= bestAt) {
        best = r.moduleVersion;
        bestAt = at;
      }
    }
    return best;
  } catch {
    return undefined;
  }
}

export function WorkspaceConnectionsPanel() {
  const {
    workspaces,
    activeWorkspace,
    activeId,
    switchWorkspace,
    addWorkspace,
    removeWorkspace,
    idbNamespace,
  } = useWorkspace();
  const { getConnection } = useSpacetimeDB();
  const importSnapshot = useReducer(reducers.importPearSnapshotV1);

  const [name, setName] = useState("");
  const [wsUri, setWsUri] = useState("");
  const [dbName, setDbName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [addUriError, setAddUriError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const [probing, setProbing] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  async function handleSwitch(id: string) {
    if (id === activeId) return;
    const target = workspaces.find((w) => w.id === id);
    if (!target) return;

    setProbeError(null);
    setProbing(id);
    const resolved = resolveWorkspaceWsUri(target.wsUri);
    const reachable = await probeWebSocket(resolved);
    setProbing(null);

    if (!reachable) {
      setProbeError(`Can't reach ${resolved} — is SpacetimeDB running there?`);
      return;
    }

    switchWorkspace(id);
  }

  async function handleExport() {
    const conn = getConnection();
    if (!conn || !activeWorkspace) {
      setMsg("Not connected.");
      return;
    }
    setBusy(true);
    setMsg(null);
    // The export reads the client cache, but the app only subscribes to what
    // the UI needs (no subscribeToAllTables since 14384) — so hydrate the
    // full cache on demand and release it after the snapshot is built.
    let exportSub: { unsubscribe: () => void } | null = null;
    try {
      await new Promise<void>((resolve, reject) => {
        exportSub = conn
          .subscriptionBuilder()
          .onApplied(() => resolve())
          .onError((ctx) => {
            const err = (ctx as { event?: unknown }).event;
            reject(err instanceof Error ? err : new Error("Export subscription failed"));
          })
          .subscribe(
            Object.values(tables).map(
              (t) => `SELECT * FROM ${(t as { sourceName: string }).sourceName}`,
            ),
          );
      });
      const snap = buildPearSnapshotV2(conn.db, {
        wsUri: resolveWorkspaceWsUri(activeWorkspace.wsUri),
        dbName: resolveWorkspaceDbName(activeWorkspace.dbName),
        moduleVersion: readModuleVersion(conn.db),
        tablesRegistry: tables,
      });
      downloadPearSnapshotJson(snap, `pear-snapshot-${snap.exportedAt.slice(0, 10)}.json`);
      setMsg("Export downloaded.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : `${e}`);
    } finally {
      try {
        (exportSub as { unsubscribe: () => void } | null)?.unsubscribe();
      } catch {
        // Already torn down (e.g. disconnect mid-export) — nothing to release.
      }
      setBusy(false);
    }
  }

  async function handleImportV2(snapshot: PearSnapshotV2) {
    const conn = getConnection();
    if (!conn) throw new Error("Not connected.");
    const importV2 = getImportV2Reducers(conn);
    const { header, chunks, manifest } = chunkSnapshotV2(snapshot);

    setImportProgress({ done: 0, total: chunks.length });
    try {
      await importV2.importV2Begin({ headerJson: JSON.stringify(header) });
      for (const chunk of chunks) {
        await importV2.importV2Chunk({
          seq: chunk.seq,
          tableName: chunk.tableName,
          rowsJson: chunk.rowsJson,
        });
        setImportProgress({ done: chunk.seq, total: chunks.length });
      }
      await importV2.importV2Commit({ manifestJson: JSON.stringify(manifest) });
    } catch (e) {
      try {
        await importV2.importV2Abort();
      } catch {
        // best-effort abort; surface the original error
      }
      throw e;
    } finally {
      setImportProgress(null);
    }
  }

  async function handleImportFile(f: File | null) {
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const text = await f.text();
      const parsed = parsePearSnapshotJson(text);
      if (parsed.format === PEAR_SNAPSHOT_FORMAT_V2) {
        await handleImportV2(parsed.snapshot);
      } else {
        await importSnapshot({ snapshotJson: text });
      }
      setMsg("Import successful. Data will appear momentarily.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : `${e}`);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  /**
   * Open a raw WebSocket to the target and wait for an open or error.
   * Resolves true if the socket opens within the timeout, false otherwise.
   */
  function probeWebSocket(uri: string, timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* ignore */ }
        resolve(ok);
      };

      let ws: WebSocket;
      try {
        ws = new WebSocket(uri);
      } catch {
        resolve(false);
        return;
      }
      ws.onopen = () => done(true);
      ws.onerror = () => done(false);
      ws.onclose = () => done(false);
      setTimeout(() => done(false), timeoutMs);
    });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const resolved = resolveWorkspaceWsUri(wsUri.trim());
    const v = validateResolvedSpacetimeUri(resolved);
    if (!v.ok) {
      setAddUriError(v.message);
      return;
    }
    setAddUriError(null);
    setBusy(true);
    setProbing("add");

    const reachable = await probeWebSocket(resolved);
    setProbing(null);
    if (!reachable) {
      setBusy(false);
      setAddUriError(
        `Can't reach ${resolved} — make sure SpacetimeDB is running at that address.`
      );
      return;
    }

    const n = name.trim() || "Workspace";
    addWorkspace({
      name: n,
      wsUri: wsUri.trim(),
      dbName: dbName.trim() || "pear-dev",
    });
    setName("");
    setWsUri("");
    setDbName("");
    window.location.reload();
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        Workspaces
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        Each workspace is a SpacetimeDB server + database name. Switching reloads the app and uses a
        separate local session token and editor cache.
      </p>

      <ul className="space-y-2 mb-6">
        {workspaces.map((w) => {
          const uriErr = getWorkspaceUriValidationError(w);
          return (
            <li
              key={w.id}
              className={`flex flex-col gap-1.5 px-3 py-2 rounded border ${
                uriErr
                  ? "border-red-400/80 dark:border-red-500/60 bg-red-50/50 dark:bg-red-950/20"
                  : w.id === activeId
                    ? "border-neutral-400 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900"
                    : "border-neutral-200 dark:border-neutral-800"
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleSwitch(w.id)}
                  disabled={w.id === activeId || busy || probing !== null || !!uriErr}
                  title={uriErr ?? undefined}
                  className="text-left font-medium text-neutral-900 dark:text-white text-sm flex-1 min-w-0 truncate disabled:opacity-60"
                >
                  {w.name}
                  {w.id === activeId && (
                    <span className="ml-2 text-xs font-normal text-neutral-500">(active)</span>
                  )}
                  {probing === w.id && (
                    <span className="ml-2 text-xs font-normal text-neutral-500">(testing…)</span>
                  )}
                </button>
                <span
                  className={`text-xs truncate max-w-[200px] ${uriErr ? "text-red-600 dark:text-red-400" : "text-neutral-500"}`}
                  title={resolveWorkspaceWsUri(w.wsUri)}
                >
                  {resolveWorkspaceWsUri(w.wsUri)} / {resolveWorkspaceDbName(w.dbName)}
                </span>
                {workspaces.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Remove workspace “${w.name}”?`)) removeWorkspace(w.id);
                    }}
                    className="text-xs text-red-600 dark:text-red-400 hover:underline"
                  >
                    Remove
                  </button>
                )}
              </div>
              {uriErr && (
                <p className="text-xs text-red-600 dark:text-red-400 leading-snug">
                  Can’t use this address: {uriErr}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      {probeError && (
        <p className="text-xs text-red-600 dark:text-red-400 mb-4 -mt-2">{probeError}</p>
      )}

      <form onSubmit={handleAdd} className="space-y-3 mb-6 pb-6 border-b border-neutral-200 dark:border-neutral-800">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Add workspace</p>
        <input
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full px-2 py-1.5 rounded text-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700"
        />
        <input
          placeholder="ws://host:port or host:port (scheme optional)"
          value={wsUri}
          onChange={(e) => {
            setWsUri(e.target.value);
            setAddUriError(null);
          }}
          aria-invalid={!!addUriError}
          className={`w-full px-2 py-1.5 rounded text-sm bg-white dark:bg-neutral-900 border ${
            addUriError
              ? "border-red-400 dark:border-red-500/80 focus:ring-red-400/50"
              : "border-neutral-200 dark:border-neutral-700"
          }`}
        />
        {addUriError && (
          <p className="text-xs text-red-600 dark:text-red-400">{addUriError}</p>
        )}
        <input
          placeholder="Database name (default pear-dev)"
          value={dbName}
          onChange={(e) => setDbName(e.target.value)}
          className="w-full px-2 py-1.5 rounded text-sm bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700"
        />
        <button
          type="submit"
          disabled={busy}
          className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
        >
          {probing === "add" ? "Testing connection…" : "Add & connect"}
        </button>
      </form>

      <div className="space-y-3">
        <p className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Backup & restore</p>
        <p className="text-neutral-600 dark:text-neutral-400 text-sm">
          Export uses the <code className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1 rounded">pear-snapshot-v2</code> JSON format and now includes all workspace tables. Import accepts
          v1 and v2 files and only works on an empty database (no pages). AI users get stub server
          configs (re-enter API keys after import).
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={handleExport}
            disabled={busy}
            className="px-3 py-1.5 rounded text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50"
          >
            Export snapshot…
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => handleImportFile(e.target.files?.[0] ?? null)} />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="px-3 py-1.5 rounded text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50"
          >
            Import snapshot…
          </button>
        </div>
        {importProgress && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Importing… chunk {importProgress.done} of {importProgress.total}
          </p>
        )}
        {msg && <p className="text-sm text-neutral-600 dark:text-neutral-400">{msg}</p>}
      </div>

      <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-800">
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-2">
          Clear IndexedDB cache for this workspace only (editor state). Re-syncs from the server on reload.
        </p>
        <button
          type="button"
          onClick={async () => {
            setBusy(true);
            await clearIdbCache(idbNamespace);
            window.location.reload();
          }}
          disabled={busy}
          className="px-3 py-1.5 rounded text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50"
        >
          Clear cached data (this workspace)
        </button>
      </div>
    </section>
  );
}
