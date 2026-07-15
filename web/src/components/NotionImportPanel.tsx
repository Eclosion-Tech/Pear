"use client";

/**
 * NotionImportPanel — Settings panel for importing content from Notion.
 *
 * Flow:
 *   1. User clicks "Connect Notion" → OAuth popup opens at /auth/notion
 *   2. After popup closes, panel polls /api/workspaces/[slug]/notion/status
 *   3. User clicks "Import from Notion" → fetches the encrypted-token ticket
 *      and enqueues a `notion_import_job` row; the workspace worker runs the
 *      fetch + attachments + transform + import pipeline in the background.
 *   4. Progress streams live from the job row over the STDB subscription.
 *
 * Imports land under a "Notion Import" container page; existing content is
 * untouched (the reducer offsets all imported ids). Re-import is additive.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSpacetimeDB, useReducer, useTable } from "spacetimedb/react";
import { usePearWorkspaceSlug } from "@/src/lib/blobUpload";
import { reducers, tables } from "@/src/module_bindings";

type NotionStatus = {
  connected: boolean;
  notionWorkspaceName: string | null;
  importStatus: string | null;
  importError: string | null;
};

const CLOUD_BASE = process.env.NEXT_PUBLIC_CLOUD_BASE_URL ?? "";

export function NotionImportPanel() {
  const slug = usePearWorkspaceSlug();
  const { identity } = useSpacetimeDB();

  const createImportJob = useReducer(reducers.createNotionImportJob);
  const [importJobs] = useTable(tables.notion_import_job);
  const job = importJobs.length
    ? importJobs.reduce((a, b) => (a.id > b.id ? a : b))
    : undefined;
  const jobStatus = job?.status?.tag as "Pending" | "Running" | "Done" | "Failed" | undefined;

  const [status, setStatus] = useState<NotionStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!slug) return;
    setLoadingStatus(true);
    try {
      const res = await fetch(`/api/workspaces/${encodeURIComponent(slug)}/notion/status`);
      if (res.ok) setStatus(await res.json());
    } catch {
      // Network error — ignore
    } finally {
      setLoadingStatus(false);
    }
  }, [slug]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // ── OAuth popup ─────────────────────────────────────────────────────────────

  function handleConnect() {
    if (!slug) return;
    const returnTo = encodeURIComponent(window.location.href);
    const authUrl = `${CLOUD_BASE}/auth/notion?workspace_slug=${encodeURIComponent(slug)}&return_to=${returnTo}`;
    const popup = window.open(authUrl, "notion_oauth", "width=640,height=740,popup=1");
    popupRef.current = popup;

    // Poll until the popup closes, then refresh status
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (popupRef.current?.closed) {
        if (pollRef.current) clearInterval(pollRef.current);
        fetchStatus();
      }
    }, 500);
  }

  // ── Disconnect ───────────────────────────────────────────────────────────────

  async function handleDisconnect() {
    if (!slug || !confirm("Disconnect Notion? You can reconnect at any time.")) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(slug)}/notion/disconnect`,
        { method: "DELETE" }
      );
      if (res.ok) {
        setStatus(null);
        setMsg(null);
        await fetchStatus();
      } else {
        const { error } = await res.json().catch(() => ({ error: "Request failed" }));
        setMsg(error);
      }
    } finally {
      setBusy(false);
    }
  }

  // ── Import ───────────────────────────────────────────────────────────────────

  async function handleImport() {
    if (!slug || !identity) {
      setMsg("Not connected to workspace.");
      return;
    }
    setBusy(true);
    setMsg(null);

    try {
      // Fetch the encrypted-token ticket, then enqueue the background job.
      // The workspace worker does everything else; progress streams onto the
      // job row we're subscribed to.
      const res = await fetch(
        `/api/workspaces/${encodeURIComponent(slug)}/notion/import/ticket`,
        { method: "POST" }
      );
      const data = await res.json().catch(() => ({ error: "Failed to parse response" }));
      if (!res.ok || data.error) {
        setMsg(`Import failed: ${data.error ?? "Unknown error"}`);
        return;
      }
      await createImportJob({
        encryptedTokenB64: data.encryptedTokenB64,
        sourceName: data.notionWorkspaceName ?? "Notion",
        workspaceSlug: slug,
      });
      setMsg(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setMsg(`Import failed: ${message}`);
    } finally {
      setBusy(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  const importStatus = status?.importStatus;
  const isRunning =
    busy || jobStatus === "Pending" || jobStatus === "Running" ||
    (!job && importStatus === "running");
  const isDone = jobStatus ? jobStatus === "Done" : importStatus === "done";
  const isError = jobStatus ? jobStatus === "Failed" : importStatus === "error";
  const progressLine = job && (jobStatus === "Pending" || jobStatus === "Running")
    ? `${job.stage}${job.pagesTotal > 0 ? ` (${job.pagesDone}/${job.pagesTotal})` : ""}`
    : null;
  const jobError = job?.error ?? undefined;

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        Import from Notion
      </h2>

      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-2">
        Connect your Notion account to import pages, databases, attachments, and comments into this
        workspace. Everything lands under a &quot;Notion Import&quot; page — existing content is untouched.
      </p>

      <details className="mb-4 text-xs text-neutral-500 dark:text-neutral-400">
        <summary className="cursor-pointer select-none hover:text-neutral-700 dark:hover:text-neutral-300">
          What doesn&apos;t come over*
        </summary>
        <ul className="mt-1.5 ml-4 space-y-0.5 list-disc">
          <li>
            <strong>Teamspaces</strong> — Notion&apos;s API doesn&apos;t expose them; teamspace pages import
            side by side at the top level.
          </li>
          <li>
            <strong>Database views</strong> — each database gets a default grid; board, calendar,
            timeline, and gallery views don&apos;t transfer.
          </li>
          <li>
            <strong>Rollups</strong> — column definitions import, but cross-row aggregation isn&apos;t
            computed yet.
          </li>
          <li>
            <strong>Formulas</strong> — expressions import and are re-evaluated here; results can
            differ for functions Pear doesn&apos;t support.
          </li>
          <li>
            <strong>Files over 50&nbsp;MB</strong> (or beyond your storage quota) are skipped; their
            links keep temporary Notion URLs that expire.
          </li>
          <li>
            <strong>People properties</strong> import as names — they aren&apos;t linked to workspace
            members.
          </li>
          <li>
            <strong>AI meeting-note transcripts</strong> — titles and any summary the API exposes
            import; transcript bodies Notion withholds become a named placeholder.
          </li>
          <li>
            <strong>Inline comments</strong> — page-level comment threads import; comments anchored
            to individual blocks don&apos;t (fetching them per block would exceed API rate limits).
            Original authors are noted by name inside each message.
          </li>
          <li>
            <strong>Image &amp; custom-emoji page icons</strong> — Pear page icons are emoji;
            image icons are skipped.
          </li>
          <li>
            <strong>Date ranges</strong> — the start date imports; end dates aren&apos;t kept yet.
          </li>
          <li>
            <strong>Permissions</strong> — Notion page sharing doesn&apos;t transfer; imported pages
            follow this workspace&apos;s access rules.
          </li>
        </ul>
      </details>

      {loadingStatus && !status ? (
        <p className="text-sm text-neutral-500">Checking connection…</p>
      ) : status?.connected ? (
        <div className="space-y-4">
          {/* Connected state */}
          <div className="flex items-center gap-3 px-3 py-2 rounded border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900">
            <span className="text-green-600 dark:text-green-400 text-sm">●</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-neutral-900 dark:text-white">
                {status.notionWorkspaceName ?? "Notion workspace"}
              </p>
              <p className="text-xs text-neutral-500">Connected</p>
            </div>
            <button
              type="button"
              onClick={handleDisconnect}
              disabled={isRunning}
              className="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400 disabled:opacity-40"
            >
              Disconnect
            </button>
          </div>

          {/* Import status badges */}
          {isDone && (
            <div className="px-3 py-2 rounded border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 text-sm text-green-700 dark:text-green-300">
              ✓ Import complete — your Notion content is in Pear.
            </div>
          )}
          {isError && (
            <div className="px-3 py-2 rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 text-sm text-red-700 dark:text-red-400">
              Import failed: {jobError ?? status.importError ?? "Unknown error"}
            </div>
          )}

          {/* Actions — re-imports are additive (each run lands under its own
              container page), so the button stays available after success. */}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleImport}
              disabled={isRunning}
              className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-40"
            >
              {isRunning
                ? "Importing…"
                : isError
                  ? "Retry import"
                  : isDone
                    ? "Import again"
                    : "Import from Notion"}
            </button>
          </div>

          {msg && (
            <p className="text-sm text-neutral-600 dark:text-neutral-400">{msg}</p>
          )}

          {isRunning && !msg && (
            <p className="text-sm text-neutral-500 dark:text-neutral-400 animate-pulse">
              {progressLine ?? "Starting background import…"}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <button
            type="button"
            onClick={handleConnect}
            disabled={busy}
            className="px-3 py-1.5 rounded text-sm font-medium bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-40"
          >
            Connect Notion
          </button>
          {msg && <p className="text-sm text-neutral-600 dark:text-neutral-400">{msg}</p>}
        </div>
      )}
    </section>
  );
}
