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
  buildPearSnapshotV1,
  downloadPearSnapshotJson,
  parsePearSnapshotV1Json,
} from "@/src/lib/pearExport";
import { clearIdbCache } from "@/src/lib/spacetime";
import { reducers } from "@/src/module_bindings";

export function WorkspaceConnectionsPanel() {
  const {
    workspaces,
    activeWorkspace,
    activeId,
    setActiveId,
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

    setActiveId(id);
    window.location.reload();
  }

  async function handleExport() {
    const conn = getConnection();
    if (!conn || !activeWorkspace) {
      setMsg("Not connected.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const snap = buildPearSnapshotV1(conn, {
        wsUri: resolveWorkspaceWsUri(activeWorkspace.wsUri),
        dbName: resolveWorkspaceDbName(activeWorkspace.dbName),
      });
      const safe = activeWorkspace.name.replace(/[^\w\-]+/g, "_").slice(0, 40) || "workspace";
      downloadPearSnapshotJson(snap, `pear-${safe}-${snap.exportedAt.slice(0, 10)}.json`);
      setMsg("Export downloaded.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : `${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleImportFile(f: File | null) {
    if (!f) return;
    setBusy(true);
    setMsg(null);
    try {
      const text = await f.text();
      parsePearSnapshotV1Json(text);
      importSnapshot({ snapshotJson: text });
      setMsg("Import requested. If the server accepts it, data will appear after sync.");
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
          Export and import use the <code className="text-xs bg-neutral-100 dark:bg-neutral-800 px-1 rounded">pear-snapshot-v1</code> JSON format (public tables). Import only works on an
          empty database (no pages). AI users get stub server configs (re-enter API keys after import).
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
