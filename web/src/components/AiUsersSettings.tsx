"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTable, useSpacetimeDB } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  useAiUserProfiles,
  useAiUserRoutines,
  useCreateAiUser,
  useCreateMemoryConsolidationRoutine,
  useCreateSensorTriageRoutine,
  useDeleteAiUser,
  useDeleteAiUserRoutine,
  useDisableAiUserMemory,
  usePatchAiUserProfileSettings,
  useProvisionAiUserMemory,
  useSetAiUserModel,
  useSetAiUserRoutineEnabled,
  useSetAiUserSerperApiKey,
  useSetAiUserWorkerToken,
  useUpdateAiUserSystemPrompt,
  type AiUserProfileRow,
} from "@/src/hooks/useAiUsers";
import { useWorkerLiveness } from "@/src/hooks/useOrcha";
import {
  hostCreateAiUser,
  hostDeleteAiUser,
  identityFromHex,
  isAiUserHostDelegated,
  mintIdentity,
  PROVIDER_OPTIONS,
  providerDefaults,
  providerNeedsEndpoint,
  providerModels,
  PROVIDER_TAG_BY_NAME,
  utilityModelFor,
  type ProviderTag,
} from "@/src/lib/aiUserApi";
import { resolveWorkspaceWsUri } from "@/src/lib/workspaceConnections";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { optionStringFromRow } from "@/src/lib/spacetime";
import type {
  CreateAiUserParams,
  SetAiUserSerperApiKeyParams,
  SetAiUserWorkerTokenParams,
} from "@/src/module_bindings/types/reducers";

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Create a new AI user. Two paths, like the rest of AI-user management:
 *  - host-delegated (`hostCreateAiUser`) when an external host owns the lifecycle;
 *  - self-hosted: mint a SpacetimeDB identity in the browser, call `create_ai_user`,
 *    then persist the minted token via `set_ai_user_worker_token` so the worker can
 *    spawn an `AiUserWorker` that connects as this AI user. Without that last step
 *    the AI user exists but never answers conversations.
 */
function CreateAiUserForm({ onDone }: { onDone: () => void }) {
  const { identity } = useSpacetimeDB();
  const { activeWorkspace } = useWorkspace();
  const createAiUser = useCreateAiUser();
  const setAiUserWorkerToken = useSetAiUserWorkerToken();
  const hostDelegated = isAiUserHostDelegated();

  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<ProviderTag>("Anthropic");
  const [model, setModel] = useState(providerDefaults("Anthropic").defaultModel);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleProviderChange(next: ProviderTag) {
    const prev = providerDefaults(provider);
    const nextDefault = providerDefaults(next);
    setProvider(next);
    if (model.trim() === "" || model === prev.defaultModel) setModel(nextDefault.defaultModel);
    if (endpoint.trim() === "" || endpoint === prev.defaultEndpoint) setEndpoint(nextDefault.defaultEndpoint);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const name = displayName.trim();
    const modelName = model.trim();
    const endpointValue = optionalString(endpoint);
    const apiKeyValue = optionalString(apiKey);
    const systemPromptValue = optionalString(systemPrompt);

    setError(null);
    if (!name) return setError("Display name is required");
    if (!modelName) return setError("Model is required");
    if (providerNeedsEndpoint(provider) && !endpointValue) {
      return setError("Endpoint is required for Ollama and OpenAI-compatible providers");
    }

    setBusy(true);
    try {
      if (hostDelegated) {
        await hostCreateAiUser({
          displayName: name,
          provider,
          model: modelName,
          endpoint: endpointValue,
          apiKey: apiKeyValue,
          systemPrompt: systemPromptValue,
          maxTokens: undefined,
          avatarUrl: undefined,
        });
      } else {
        if (!identity) throw new Error("Connect to the workspace before creating an AI user.");
        if (!activeWorkspace) throw new Error("No active workspace connection is configured.");

        const minted = await mintIdentity(resolveWorkspaceWsUri(activeWorkspace.wsUri));
        const aiUserIdentity = await identityFromHex(minted.identity);

        await createAiUser({
          aiUserIdentity,
          createdByIdentity: identity,
          displayName: name,
          provider: { tag: provider },
          model: modelName,
          endpoint: endpointValue,
          apiKey: apiKeyValue,
          systemPrompt: systemPromptValue,
          maxTokens: undefined,
          avatarUrl: undefined,
        } as unknown as CreateAiUserParams);

        await setAiUserWorkerToken({
          aiUserIdentity,
          workerToken: minted.token,
        } as unknown as SetAiUserWorkerTokenParams);
      }
      setDisplayName("");
      setApiKey("");
      setSystemPrompt("");
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50";

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mb-6 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 p-4 space-y-4"
    >
      <div>
        <label className="block text-xs font-medium text-neutral-600 dark:text-neutral-400">Display name</label>
        <input
          autoFocus
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          disabled={busy}
          placeholder="e.g. Moss, Research Assistant"
          className={inputCls}
        />
      </div>

      <div>
        <span className="block text-xs font-medium text-neutral-600 dark:text-neutral-400 mb-1.5">Provider</span>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDER_OPTIONS.map((p) => (
            <button
              key={p.tag}
              type="button"
              onClick={() => handleProviderChange(p.tag)}
              disabled={busy}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors disabled:opacity-50 ${
                provider === p.tag
                  ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                  : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Model</span>
          <input
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={busy}
            placeholder="e.g. claude-haiku-4-5-20251001"
            className={`${inputCls} font-mono`}
          />
          {providerModels(provider).length > 0 && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              {providerModels(provider).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModel(m.id)}
                  disabled={busy}
                  title={m.id}
                  className={`px-2 py-0.5 rounded-md text-[11px] transition-colors disabled:opacity-50 ${
                    model === m.id
                      ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                      : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  }`}
                >
                  {m.label}
                  <span className="opacity-60"> · {m.tier}</span>
                </button>
              ))}
            </span>
          )}
          <span className="mt-1 block text-[11px] text-neutral-400 dark:text-neutral-500">
            Utility tasks (intent checks, planning) use{" "}
            <span className="font-mono">{utilityModelFor(provider, model)}</span> to save cost.
          </span>
        </label>

        {providerNeedsEndpoint(provider) && (
          <label className="block">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">Endpoint URL</span>
            <input
              type="url"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
              disabled={busy}
              placeholder={provider === "Ollama" ? "http://localhost:11434/v1" : "https://…"}
              className={inputCls}
            />
          </label>
        )}
      </div>

      <label className="block">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          API key <span className="text-neutral-400 font-normal">(stored server-side; only the AI user and operators can read it)</span>
        </span>
        <input
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={busy}
          placeholder="sk-…"
          className={`${inputCls} font-mono`}
        />
      </label>

      <label className="block">
        <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
          Assistant instructions <span className="text-neutral-400 font-normal">(optional)</span>
        </span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          disabled={busy}
          rows={3}
          placeholder="Optional system prompt for this AI user"
          className={`${inputCls} font-mono`}
        />
      </label>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="rounded-md border border-neutral-300 dark:border-neutral-700 px-3 py-1.5 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add AI user"}
        </button>
      </div>
    </form>
  );
}

function AiUserRowEditor({
  profile,
  hasMemory,
  memoryRootPageId,
  memoryBusy,
  onToggleMemory,
  onDelete,
  deleteBusy,
}: {
  profile: AiUserProfileRow;
  hasMemory: boolean;
  memoryRootPageId?: bigint;
  memoryBusy: boolean;
  onToggleMemory: () => void;
  onDelete: () => void;
  deleteBusy: boolean;
}) {
  const router = useRouter();
  const patchProfile = usePatchAiUserProfileSettings();
  const updateSystemPrompt = useUpdateAiUserSystemPrompt();
  const setSerperApiKey = useSetAiUserSerperApiKey();
  const setAiUserModel = useSetAiUserModel();
  const providerTag = PROVIDER_TAG_BY_NAME[profile.providerName] ?? "Ollama";
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [model, setModel] = useState(profile.modelName);
  const [systemPrompt, setSystemPrompt] = useState(() =>
    optionStringFromRow(profile.systemPrompt)
  );
  const [serperKeyDraft, setSerperKeyDraft] = useState("");
  const [serperBusy, setSerperBusy] = useState(false);
  const [serperMsg, setSerperMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const hostDelegated = isAiUserHostDelegated();

  useEffect(() => {
    setDisplayName(profile.displayName);
    setModel(profile.modelName);
    setSystemPrompt(optionStringFromRow(profile.systemPrompt));
  }, [profile.displayName, profile.modelName, profile.systemPrompt, profile.aiUserId]);

  const onSaveSerper = async () => {
    if (hostDelegated) return;
    setSerperMsg(null);
    setLocalErr(null);
    const trimmed = serperKeyDraft.trim();
    setSerperBusy(true);
    try {
      const params: SetAiUserSerperApiKeyParams = {
        aiUserId: profile.aiUserId,
        serperApiKey: trimmed || undefined,
      };
      await setSerperApiKey(params);
      setSerperKeyDraft("");
      setSerperMsg(
        trimmed
          ? "Serper key saved. Web search will use the Serper API for this AI user."
          : "Cleared: web search will use DuckDuckGo (or a deployment-wide SERPER_API_KEY on the worker).",
      );
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSerperBusy(false);
    }
  };

  const onSave = async () => {
    const name = displayName.trim();
    const prompt = systemPrompt.trim();
    const modelName = model.trim();
    if (!name) {
      setLocalErr("Display name is required");
      return;
    }
    if (!modelName) {
      setLocalErr("Model is required");
      return;
    }
    setLocalErr(null);
    setBusy(true);
    try {
      const nameChanged = name !== profile.displayName;
      const promptChanged = prompt !== optionStringFromRow(profile.systemPrompt);
      const modelChanged = modelName !== profile.modelName;
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
      if (modelChanged) {
        // Only the model changes; provider, key, and endpoint are preserved.
        await setAiUserModel({ aiUserId: profile.aiUserId, model: modelName });
      }
    } catch (e) {
      setLocalErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const rowBusy = busy || memoryBusy || serperBusy || deleteBusy;

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

        <div>
          <label
            htmlFor={`ai-user-serper-${profile.aiUserId.toString()}`}
            className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
          >
            Web search (optional Serper API key)
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 mb-1.5 max-w-lg">
            When set, the built-in <code className="text-xs">web_search</code> tool uses{" "}
            <a
              className="underline"
              href="https://serper.dev"
              target="_blank"
              rel="noreferrer"
            >
              Serper
            </a>{" "}
            instead of the default DuckDuckGo fetch. The key is stored like the
            model API key (only the AI user identity and operators can read it). Leave
            the field empty and save to clear. Self-hosted workers can also set{" "}
            <code className="text-xs">SERPER_API_KEY</code> for all users.
          </p>
          {hostDelegated ? (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Web search keys are not editable here when AI users are managed by the host
              app.
            </p>
          ) : (
            <>
              <div className="flex flex-col sm:flex-row sm:items-end gap-2 sm:gap-3">
                <input
                  id={`ai-user-serper-${profile.aiUserId.toString()}`}
                  type="password"
                  autoComplete="off"
                  value={serperKeyDraft}
                  onChange={(e) => setSerperKeyDraft(e.target.value)}
                  disabled={rowBusy}
                  placeholder="sk-… (paste new key, or clear and save to remove)"
                  className="mt-0.5 flex-1 min-w-0 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
                />
                <button
                  type="button"
                  onClick={() => void onSaveSerper()}
                  disabled={rowBusy}
                  className="shrink-0 rounded-md border border-neutral-300 dark:border-neutral-600 bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-white hover:opacity-90 disabled:opacity-50"
                >
                  Save key
                </button>
              </div>
              {serperMsg ? (
                <p className="text-xs text-green-700 dark:text-green-300 mt-1.5" role="status">
                  {serperMsg}
                </p>
              ) : null}
            </>
          )}
        </div>

        <div>
          <label
            htmlFor={`ai-user-model-${profile.aiUserId.toString()}`}
            className="block text-sm font-medium text-neutral-800 dark:text-neutral-200"
          >
            Default model
          </label>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 mb-1.5 max-w-lg">
            The model this AI user replies with by default. Pick one the existing API key can reach
            (the {profile.providerName} family) — the provider and key are unchanged.
          </p>
          <input
            id={`ai-user-model-${profile.aiUserId.toString()}`}
            type="text"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            disabled={rowBusy}
            placeholder="e.g. claude-haiku-4-5-20251001"
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
          />
          {providerModels(providerTag).length > 0 && (
            <span className="mt-1.5 flex flex-wrap items-center gap-1">
              {providerModels(providerTag).map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setModel(m.id)}
                  disabled={rowBusy}
                  title={m.id}
                  className={`px-2 py-0.5 rounded-md text-[11px] transition-colors disabled:opacity-50 ${
                    model === m.id
                      ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                      : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
                  }`}
                >
                  {m.label}
                  <span className="opacity-60"> · {m.tier}</span>
                </button>
              ))}
            </span>
          )}
          <span className="mt-1 block text-[11px] text-neutral-400 dark:text-neutral-500">
            Utility tasks (intent checks, planning) use{" "}
            <span className="font-mono">{utilityModelFor(providerTag, model)}</span> to save cost.
          </span>
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
            {profile.providerName}
          </span>

          <span className="ml-auto" />
          {confirmingDelete ? (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-neutral-500 dark:text-neutral-400">Delete this AI user?</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingDelete(false);
                  onDelete();
                }}
                disabled={rowBusy}
                className="px-2 py-1 rounded text-xs font-medium text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-50 transition-colors"
              >
                {deleteBusy ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={rowBusy}
                className="px-2 py-1 rounded text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              disabled={rowBusy}
              className="px-2.5 py-1 text-xs rounded border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors"
              title="Remove this AI user"
            >
              Remove
            </button>
          )}
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
            {hasMemory && memoryRootPageId !== undefined ? (
              <button
                type="button"
                onClick={() => router.push(`/workspace/${memoryRootPageId}`)}
                className="mt-2 text-xs font-medium text-green-700 dark:text-green-400 hover:underline"
              >
                View memory →
              </button>
            ) : null}
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

        <RoutinesSection aiUserId={profile.aiUserId} hasMemory={hasMemory} />
      </div>
    </li>
  );
}

/** One-line label for a routine, derived from its prompt. */
function routineLabel(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 70 ? `${flat.slice(0, 70)}…` : flat;
}

/** Human-friendly interval, e.g. 3600 → "1h", 604800 → "7d". */
function formatInterval(secs: number): string {
  if (secs > 0 && secs % 86400 === 0) return `${secs / 86400}d`;
  if (secs > 0 && secs % 3600 === 0) return `${secs / 3600}h`;
  if (secs > 0 && secs % 60 === 0) return `${secs / 60}m`;
  return `${secs}s`;
}

/**
 * Scheduled routines for one AI user: list existing routines (pause/resume,
 * delete) and add the two built-in ones (sensor triage, weekly consolidation).
 * Creator/admin-gated server-side; the AI user cannot author its own routines.
 */
function RoutinesSection({
  aiUserId,
  hasMemory,
}: {
  aiUserId: bigint;
  hasMemory: boolean;
}) {
  const allRoutines = useAiUserRoutines();
  const createTriage = useCreateSensorTriageRoutine();
  const createConsolidation = useCreateMemoryConsolidationRoutine();
  const setEnabled = useSetAiUserRoutineEnabled();
  const deleteRoutine = useDeleteAiUserRoutine();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const routines = allRoutines
    .filter((r) => r.aiUserId === aiUserId)
    .sort((a, b) => Number(a.scheduledId - b.scheduledId));

  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  // Auto-create the routine conversation on first run (no explicit target).
  const noneConv = undefined;

  return (
    <div className="pt-3 mt-2 border-t border-neutral-200 dark:border-neutral-800">
      <div className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
        Scheduled routines
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1 max-w-md">
        Standing instructions this assistant runs on a schedule (as itself). Only creators and
        admins can change these.
      </p>

      {routines.length > 0 && (
        <ul className="mt-2 space-y-1.5">
          {routines.map((r) => {
            const last = optionStringFromRow(r.lastStatus);
            return (
              <li
                key={String(r.scheduledId)}
                className="flex items-start justify-between gap-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate text-neutral-700 dark:text-neutral-300">
                    {routineLabel(r.prompt)}
                  </div>
                  <div className="text-neutral-400 dark:text-neutral-500">
                    every {formatInterval(Number(r.intervalSecs))}
                    {last ? ` · last: ${last}` : ""}
                    {!r.enabled ? " · paused" : ""}
                  </div>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void run(() =>
                        setEnabled({ scheduledId: r.scheduledId, enabled: !r.enabled }),
                      )
                    }
                    className="text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200 disabled:opacity-50"
                  >
                    {r.enabled ? "Pause" : "Resume"}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void run(() => deleteRoutine({ scheduledId: r.scheduledId }))}
                    className="text-red-500 hover:text-red-700 disabled:opacity-50"
                    aria-label="Delete routine"
                  >
                    Remove
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(() =>
              createTriage({ aiUserId, intervalSecs: 3600n, conversationId: noneConv }),
            )
          }
          className="rounded-md border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
        >
          + Sensor triage (hourly)
        </button>
        {hasMemory && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(() =>
                createConsolidation({
                  aiUserId,
                  intervalSecs: 604800n,
                  conversationId: noneConv,
                }),
              )
            }
            className="rounded-md border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
          >
            + Weekly memory consolidation
          </button>
        )}
      </div>
      {err ? (
        <p className="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">
          {err}
        </p>
      ) : null}
    </div>
  );
}

/** Small pill showing whether the workspace's AI worker is alive, from its
 * heartbeat. AI users can't respond if the worker is down, so this tells a
 * human why an assistant might be silent. */
function WorkerStatusBadge() {
  const { status } = useWorkerLiveness();
  if (status === "unknown") return null;
  const alive = status === "alive";
  return (
    <span
      title={
        alive
          ? "The AI worker is connected and sending heartbeats."
          : "No recent heartbeat — the AI worker may be down; assistants won't respond until it reconnects."
      }
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
        alive
          ? "bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400"
          : "bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${alive ? "bg-green-500" : "bg-amber-500"}`}
      />
      {alive ? "Worker online" : "Worker offline"}
    </span>
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
  const deleteAiUser = useDeleteAiUser();
  const hostDelegated = isAiUserHostDelegated();
  const [busyId, setBusyId] = useState<bigint | null>(null);
  const [deletingId, setDeletingId] = useState<bigint | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const memoryRowFor = (aiUserId: bigint) => memories.find((m) => m.aiUserId === aiUserId);

  const onDelete = useCallback(
    async (aiUserId: bigint) => {
      setErr(null);
      setDeletingId(aiUserId);
      try {
        // Deleting the config row drops its worker_token too; the worker's
        // reconcile (on the ai_user_config delete event) tears down the
        // AiUserWorker. Host-delegated path goes through lifecycle instead.
        if (hostDelegated) {
          await hostDeleteAiUser(aiUserId);
        } else {
          await deleteAiUser({ aiUserId });
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setDeletingId(null);
      }
    },
    [deleteAiUser, hostDelegated],
  );

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
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
            AI users
          </h2>
          <WorkerStatusBadge />
        </div>
        {isActive && !addOpen && (
          <button
            type="button"
            onClick={() => {
              setErr(null);
              setAddOpen(true);
            }}
            className="rounded-md border border-neutral-200 dark:border-neutral-700 px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
          >
            Add AI user
          </button>
        )}
      </div>

      {!isActive ? (
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Connect to the workspace to manage AI users.
        </p>
      ) : (
        <>
          {addOpen && <CreateAiUserForm onDone={() => setAddOpen(false)} />}

          {profiles.length === 0 ? (
            !addOpen && (
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                No AI users in this workspace yet. Use “Add AI user” to create one.
              </p>
            )
          ) : (
            <ul className="space-y-6">
              {profiles.map((p) => (
                <AiUserRowEditor
                  key={p.aiUserId.toString()}
                  profile={p}
                  hasMemory={memoryRowFor(p.aiUserId) !== undefined}
                  memoryRootPageId={memoryRowFor(p.aiUserId)?.rootPageId}
                  memoryBusy={busyId === p.aiUserId}
                  onToggleMemory={() => void onToggleMemory(p.aiUserId, !memoryRowFor(p.aiUserId))}
                  onDelete={() => void onDelete(p.aiUserId)}
                  deleteBusy={deletingId === p.aiUserId}
                />
              ))}
            </ul>
          )}
        </>
      )}

      {err ? (
        <p className="mt-4 text-sm text-red-600 dark:text-red-400" role="alert">
          {err}
        </p>
      ) : null}
    </section>
  );
}
