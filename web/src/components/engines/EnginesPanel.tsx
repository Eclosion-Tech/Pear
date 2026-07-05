"use client";

/**
 * Engines panel — desktop-only surface (mounts when running inside the pear
 * desktop shell; renders nothing in a plain browser).
 *
 * M1 surface: detect local agent CLIs, set each up as its own pear AI user
 * (EngineSetupWizard), start sessions with the pear MCP server injected, and
 * watch/steer the live event stream (SessionView).
 */

import { useEffect, useState } from "react";
import {
  enginesBindings,
  enginesDetect,
  isTauri,
  sessionResume,
  sessionStart,
  sessionsList,
  type EngineBinding,
  type EngineEvent,
  type EngineInfo,
  type SessionMeta,
} from "@/src/lib/tauri";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { resolveWorkspaceDbName, resolveWorkspaceWsUri } from "@/src/lib/workspaceConnections";
import { EngineSetupWizard, workspaceKeyFor } from "./EngineSetupWizard";
import { SessionView } from "./SessionView";

type View =
  | { name: "list" }
  | { name: "setup"; engine: EngineInfo }
  | { name: "new-session"; engine: EngineInfo }
  | { name: "resume-session"; session: SessionMeta }
  | { name: "session"; session: SessionMeta };

export function EnginesPanel() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !isTauri()) return null;
  return <EnginesPanelInner />;
}

function EnginesPanelInner() {
  const { activeWorkspace } = useWorkspace();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>({ name: "list" });
  const [engines, setEngines] = useState<EngineInfo[] | null>(null);
  const [bindings, setBindings] = useState<EngineBinding[]>([]);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [events, setEvents] = useState<EngineEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const workspaceKey = activeWorkspace
    ? workspaceKeyFor(activeWorkspace.wsUri, activeWorkspace.dbName)
    : null;

  useEffect(() => {
    if (!open || engines !== null) return;
    enginesDetect()
      .then(setEngines)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, [open, engines]);

  useEffect(() => {
    if (!open || !workspaceKey) return;
    enginesBindings(workspaceKey).then(setBindings).catch(() => setBindings([]));
    sessionsList(workspaceKey).then(setSessions).catch(() => setSessions([]));
  }, [open, workspaceKey, view.name]);

  async function startSession(engine: EngineInfo, opts: NewSessionOptions) {
    if (!activeWorkspace || !workspaceKey) return;
    setError(null);
    setEvents([]);
    const session = await sessionStart(
      {
        engine: engine.id,
        cwd: opts.cwd,
        prompt: opts.prompt,
        title: opts.prompt.slice(0, 60),
        workspaceKey,
        spacetimedbUri: resolveWorkspaceWsUri(activeWorkspace.wsUri),
        dbName: resolveWorkspaceDbName(activeWorkspace.dbName),
        model: opts.model || undefined,
        useWorktree: opts.useWorktree || undefined,
      },
      (event) => setEvents((prev) => [...prev, event]),
    );
    sessionsList(workspaceKey).then(setSessions).catch(() => undefined);
    setView({ name: "session", session });
  }

  async function resumeSession(session: SessionMeta, prompt: string) {
    if (!workspaceKey) return;
    setError(null);
    setEvents([]);
    const resumed = await sessionResume(
      {
        sessionId: session.id,
        prompt,
      },
      (event) => setEvents((prev) => [...prev, event]),
    );
    sessionsList(workspaceKey).then(setSessions).catch(() => undefined);
    setView({ name: "session", session: resumed });
  }

  const recentSessions = [...sessions]
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, 5);

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col items-end gap-2">
      {open && (
        <div className="w-[26rem] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-4 shadow-xl">
          {view.name === "list" && (
            <div className="space-y-3">
              <div>
                <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">Agent engines</h3>
                <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                  Local agent CLIs running as pear AI users — with workspace memory via MCP.
                </p>
              </div>
              {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
              {engines === null && !error && <p className="text-xs text-neutral-500">Detecting…</p>}
              {engines?.map((engine) => {
                const binding = bindings.find((b) => b.engine === engine.id);
                return (
                  <div
                    key={engine.id}
                    className="rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2"
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-sm text-neutral-900 dark:text-neutral-100">
                          {engine.displayName}
                        </div>
                        <div className="text-[11px] text-neutral-500">
                          {engine.installed ? engine.version : "not installed"}
                          {binding && ` · ${binding.displayName}`}
                        </div>
                      </div>
                      {engine.installed && (
                        <button
                          type="button"
                          onClick={() =>
                            setView(
                              binding
                                ? { name: "new-session", engine }
                                : { name: "setup", engine },
                            )
                          }
                          className="rounded-md bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-1.5"
                        >
                          {binding ? "New session" : "Set up"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
              {recentSessions.length > 0 && (
                <div className="space-y-2 border-t border-neutral-200 dark:border-neutral-800 pt-3">
                  <h4 className="text-xs font-semibold text-neutral-700 dark:text-neutral-300">
                    Recent sessions
                  </h4>
                  {recentSessions.map((session) => (
                    <div
                      key={session.id}
                      className="rounded-md border border-neutral-200 dark:border-neutral-800 px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm text-neutral-900 dark:text-neutral-100">
                            {session.title || "Untitled session"}
                          </div>
                          <div className="truncate text-[11px] text-neutral-500">
                            {session.engine} · {session.status} · {formatTime(session.createdAtMs)}
                          </div>
                        </div>
                        <button
                          type="button"
                          disabled={!session.engineSessionId}
                          onClick={() => setView({ name: "resume-session", session })}
                          className="shrink-0 rounded-md border border-neutral-300 dark:border-neutral-700 disabled:opacity-50 text-xs px-3 py-1.5"
                        >
                          Resume
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {view.name === "setup" && (
            <EngineSetupWizard
              engine={view.engine.id}
              engineDisplayName={view.engine.displayName}
              onDone={() => setView({ name: "new-session", engine: view.engine })}
              onCancel={() => setView({ name: "list" })}
            />
          )}

          {view.name === "new-session" && (
            <NewSessionForm
              engine={view.engine}
              onStart={(opts) =>
                startSession(view.engine, opts).catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : String(err)),
                )
              }
              onCancel={() => setView({ name: "list" })}
            />
          )}

          {view.name === "resume-session" && (
            <ResumeSessionForm
              session={view.session}
              onResume={(prompt) =>
                resumeSession(view.session, prompt).catch((err: unknown) =>
                  setError(err instanceof Error ? err.message : String(err)),
                )
              }
              onCancel={() => setView({ name: "list" })}
            />
          )}

          {view.name === "session" && (
            <SessionView
              session={view.session}
              events={events}
              onClose={() => setView({ name: "list" })}
            />
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="rounded-full bg-green-600 hover:bg-green-700 text-white text-sm font-semibold px-4 py-2 shadow-lg"
      >
        ⚙ Engines
      </button>
    </div>
  );
}

function formatTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

interface NewSessionOptions {
  cwd: string;
  prompt: string;
  model?: string;
  useWorktree?: boolean;
}

function NewSessionForm({
  engine,
  onStart,
  onCancel,
}: {
  engine: EngineInfo;
  onStart: (opts: NewSessionOptions) => void;
  onCancel: () => void;
}) {
  const [cwd, setCwd] = useState("~/");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [useWorktree, setUseWorktree] = useState(false);
  return (
    <div className="space-y-3">
      <h4 className="text-sm font-semibold text-neutral-900 dark:text-white">
        New {engine.displayName} session
      </h4>
      <div>
        <label className="text-[11px] font-semibold text-neutral-500">Working directory</label>
        <input
          type="text"
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="text-[11px] font-semibold text-neutral-500">Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="What should the agent do?"
          className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
        />
      </div>
      <div>
        <label className="text-[11px] font-semibold text-neutral-500">
          Model <span className="font-normal">(optional — engine default if blank)</span>
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder={engine.id === "codex" ? "e.g. gpt-5.5-codex" : "e.g. opus"}
          className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={useWorktree}
          onChange={(e) => setUseWorktree(e.target.checked)}
        />
        Isolate in a git worktree (branch <code className="text-[10px]">agent/…</code>)
      </label>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!prompt.trim()}
          onClick={() =>
            onStart({
              cwd: cwd.trim() || "~/",
              prompt: prompt.trim(),
              model: model.trim() || undefined,
              useWorktree,
            })
          }
          className="rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5"
        >
          Start
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-xs px-3 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function ResumeSessionForm({
  session,
  onResume,
  onCancel,
}: {
  session: SessionMeta;
  onResume: (prompt: string) => void;
  onCancel: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  return (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-neutral-900 dark:text-white">
          Resume session
        </h4>
        <p className="mt-1 truncate text-xs text-neutral-500 dark:text-neutral-400">
          {session.title || "Untitled session"} · {session.cwd}
        </p>
      </div>
      <div>
        <label className="text-[11px] font-semibold text-neutral-500">Follow-up prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          placeholder="Continue with…"
          className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-2 py-1.5 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!prompt.trim()}
          onClick={() => onResume(prompt.trim())}
          className="rounded-md bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5"
        >
          Resume
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 text-xs px-3 py-1.5"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
