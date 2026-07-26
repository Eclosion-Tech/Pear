"use client";

import { useEffect, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useCurrentUser } from "@/src/hooks/useUser";
import { useSetWorkspaceSetting } from "@/src/hooks/useWorkspaceSettings";

/**
 * Workspace-wide policy governing how AI users behave with each other.
 *
 * This is deliberately not a per-user preference: one member raising their own
 * limit would change what agents do in threads everybody reads, and whoever is
 * accountable for the token spend needs to be able to see and set it. Hence
 * admin-only, matching the reducer.
 */

export const SETTING_AI_MAX_HOPS = "ai.max_hops";
/** Mirrors the worker's fallback (`MAX_AI_HOPS`) when nothing is set. */
export const AI_MAX_HOPS_DEFAULT = 6;
/** Mirrors the module's ceiling — the brake must stay a brake. */
export const AI_MAX_HOPS_CEILING = 50;

export function AgentPolicySettings() {
  const [settings] = useTable(tables.workspace_setting);
  const { user } = useCurrentUser();
  const setWorkspaceSetting = useSetWorkspaceSetting();

  const isAdmin = user?.isAdmin ?? false;
  const stored = settings.find((s) => s.key === SETTING_AI_MAX_HOPS)?.valueJson;
  const current = (() => {
    const n = Number.parseInt(String(stored ?? "").trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : AI_MAX_HOPS_DEFAULT;
  })();

  const [draft, setDraft] = useState(String(current));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow the stored value when it changes elsewhere (another admin, another
  // tab) — but never stomp what this admin is mid-way through typing.
  useEffect(() => {
    if (!saving) setDraft(String(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  async function save() {
    setError(null);
    setSaved(false);
    const n = Number.parseInt(draft.trim(), 10);
    if (!Number.isFinite(n) || n < 1) {
      setError("Enter a whole number of 1 or more.");
      return;
    }
    if (n > AI_MAX_HOPS_CEILING) {
      setError(`Maximum is ${AI_MAX_HOPS_CEILING}.`);
      return;
    }
    setSaving(true);
    try {
      await setWorkspaceSetting({ key: SETTING_AI_MAX_HOPS, valueJson: String(n) });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const dirty = draft.trim() !== String(current);

  return (
    <section className="mb-10">
      <h2 className="mb-1 text-lg font-semibold text-neutral-900 dark:text-white">
        Agent policy
      </h2>
      <p className="mb-4 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">
        How far AI users may talk to each other before a person needs to weigh in.
      </p>

      <div className="max-w-2xl rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <label
          htmlFor="ai-max-hops"
          className="block text-sm font-medium text-neutral-900 dark:text-neutral-100"
        >
          AI-to-AI reply limit
        </label>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          In a comment thread, AI users can reply to each other{" "}
          <strong className="text-neutral-700 dark:text-neutral-300">{current}</strong>{" "}
          {current === 1 ? "time" : "times"} in a row. After that they stop responding to
          each other until a person posts — any human message resets the count.
          Lower it to keep agents brief; raise it to let them work longer unattended.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <input
            id="ai-max-hops"
            type="number"
            min={1}
            max={AI_MAX_HOPS_CEILING}
            value={draft}
            disabled={!isAdmin || saving}
            onChange={(e) => setDraft(e.target.value)}
            className="w-24 rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
          />
          <button
            onClick={save}
            disabled={!isAdmin || saving || !dirty}
            className="rounded-md bg-neutral-900 px-3 py-1 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-40 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          {saved && !dirty && (
            <span className="text-xs text-green-600 dark:text-green-400">Saved</span>
          )}
        </div>

        {!isAdmin && (
          <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">
            Only a workspace admin can change this.
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        <p className="mt-3 text-xs text-neutral-400 dark:text-neutral-500">
          Default {AI_MAX_HOPS_DEFAULT}, maximum {AI_MAX_HOPS_CEILING}. The cap exists so
          the limit stays a real stop — an unbounded value would remove the brake while
          looking like it was still there.
        </p>
      </div>
    </section>
  );
}
