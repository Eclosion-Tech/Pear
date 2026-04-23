"use client";

import { useCallback, useEffect, useState } from "react";
import { useTable, useSpacetimeDB } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import type { AiUserProfile } from "@/src/module_bindings/types";
import {
  useAiUserProfiles,
  useDisableAiUserMemory,
  usePatchAiUserProfileSettings,
  useProvisionAiUserMemory,
  useUpdateAiUserSystemPrompt,
  type AiUserProfileRow,
} from "@/src/hooks/useAiUsers";

function optionString(sp: AiUserProfile["systemPrompt"]): string {
  if (sp == null) return "";
  if (sp.tag === "none") return "";
  return sp.value;
}

function AiUserRowEditor({
  profile,
  hasMemory,
  memoryBusy,
  onToggleMemory,
}: {
  profile: AiUserProfileRow;
  hasMemory: boolean;
  memoryBusy: boolean;
  onToggleMemory: () => void;
}) {
  const patchProfile = usePatchAiUserProfileSettings();
  const updateSystemPrompt = useUpdateAiUserSystemPrompt();
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [systemPrompt, setSystemPrompt] = useState(() => optionString(profile.systemPrompt));
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  useEffect(() => {
    setDisplayName(profile.displayName);
    setSystemPrompt(optionString(profile.systemPrompt));
  }, [profile.displayName, profile.systemPrompt, profile.aiUserId]);

  const onSave = async () => {
    const name = displayName.trim();
    const prompt = systemPrompt.trim();
    if (!name) {
      setLocalErr("Display name is required");
      return;
    }
    setLocalErr(null);
    setBusy(true);
    try {
      const nameChanged = name !== profile.displayName;
      const promptChanged = prompt !== optionString(profile.systemPrompt);
      if (nameChanged) {
        await patchProfile({
          aiUserId: profile.aiUserId,
          displayName: name,
          avatarUrl: profile.avatarUrl,
        });
      }
      if (promptChanged) {
        await updateSystemPrompt({
          aiUserId: profile.aiUserId,
          systemPrompt: prompt === "" ? null : prompt,
        });
      }
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rowBusy = busy || memoryBusy;

  return (
    <li className="py-3 border-b border-neutral-200 dark:border-neutral-800 last:border-0">
      <div className="space-y-4">
        <div>
          <label
            htmlFor={`ai-user-name-${profile.aiUserId.toString()}`}
            className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
          >
            Display name
          </label>
          <input
            id={`ai-user-name-${profile.aiUserId.toString()}`}
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={rowBusy}
            className="mt-1.5 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
          />
        </div>

        <div>
          <label
            htmlFor={`ai-user-prompt-${profile.aiUserId.toString()}`}
            className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
          >
            Assistant instructions (system prompt)
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 mb-1.5 max-w-lg">
            Shown to the model as fixed context for this AI user. Clear the field to remove custom
            instructions.
          </p>
          <textarea
            id={`ai-user-prompt-${profile.aiUserId.toString()}`}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            disabled={rowBusy}
            rows={5}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={rowBusy}
            className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
          >
            Save
          </button>
          <span className="text-sm text-neutral-500 dark:text-neutral-400">
            {profile.providerName} · {profile.modelName}
          </span>
        </div>

        {localErr ? (
          <p className="text-sm text-red-600 dark:text-red-400" role="alert">
            {localErr}
          </p>
        ) : null}

        <div className="pt-2 flex items-center justify-between gap-3 border-t border-neutral-200 dark:border-neutral-800">
          <div className="min-w-0">
            <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Private memory pages
            </div>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-md">
              Hidden Doc subtree injected into this assistant&apos;s system context for persona, notes,
              and long-term memory. Only creators and admins can change this.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={hasMemory}
            disabled={rowBusy}
            onClick={onToggleMemory}
            className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-green-500 dark:focus-visible:ring-offset-neutral-900 disabled:opacity-50 ${
              hasMemory
                ? "bg-green-600 border-green-600"
                : "bg-neutral-200 border-neutral-300 dark:bg-neutral-700 dark:border-neutral-600"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow transition-transform mt-px ${
                hasMemory ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
      </div>
    </li>
  );
}

/**
 * Workspace settings: per–AI-user profile, system prompt, and private memory subtree.
 */
export function AiUsersSettings() {
  const { isActive } = useSpacetimeDB();
  const { profiles } = useAiUserProfiles();
  const [memories] = useTable(tables.ai_user_memory);
  const provisionMemory = useProvisionAiUserMemory();
  const disableMemory = useDisableAiUserMemory();
  const [busyId, setBusyId] = useState<bigint | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const memoryRowFor = (aiUserId: bigint) => memories.find((m) => m.aiUserId === aiUserId);

  const onToggleMemory = useCallback(
    async (aiUserId: bigint, enable: boolean) => {
      setErr(null);
      setBusyId(aiUserId);
      try {
        if (enable) {
          await provisionMemory({ aiUserId });
        } else {
          const ok = window.confirm(
            "Turn off private memory for this AI user? Hidden memory pages will be soft-deleted (moved to trash). You can enable again later to start a fresh subtree.",
          );
          if (!ok) return;
          await disableMemory({ aiUserId });
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusyId(null);
      }
    },
    [provisionMemory, disableMemory],
  );

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        AI users
      </h2>

      {!isActive ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Connect to the workspace to manage AI users.
        </p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          No AI users in this workspace yet.
        </p>
      ) : (
        <ul className="space-y-6">
          {profiles.map((p) => (
            <AiUserRowEditor
              key={p.aiUserId.toString()}
              profile={p}
              hasMemory={memoryRowFor(p.aiUserId) !== undefined}
              memoryBusy={busyId === p.aiUserId}
              onToggleMemory={() => void onToggleMemory(p.aiUserId, !memoryRowFor(p.aiUserId))}
            />
          ))}
        </ul>
      )}

      {err ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}
