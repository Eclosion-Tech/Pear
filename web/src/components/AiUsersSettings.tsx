"use client";

import { useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import { Identity } from "spacetimedb";
import {
  useAiUserProfiles,
  useCreateAiUser,
  useDeleteAiUser,
  useUpdateAiUserProfile,
  useUpdateAiUserConfig,
  useSetAiUserApiKey,
  type AiUserProfileRow,
} from "@/src/hooks/useAiUsers";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import {
  isAiUserHostDelegated,
  hostCreateAiUser,
  hostPatchProfile,
  hostPatchConfig,
  hostUpsertApiKey,
  hostClearApiKey,
  hostDeleteAiUser,
  mintIdentity,
  type ProviderTag,
} from "@/src/lib/aiUserApi";

const PROVIDERS = [
  { value: "Anthropic", label: "Anthropic", needsEndpoint: false },
  { value: "OpenAi", label: "OpenAI", needsEndpoint: false },
  { value: "Ollama", label: "Ollama", needsEndpoint: true },
  { value: "OpenAiCompatible", label: "OpenAI Compatible", needsEndpoint: true },
] as const satisfies ReadonlyArray<{ value: ProviderTag; label: string; needsEndpoint: boolean }>;

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  Anthropic: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"],
  OpenAi: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  Ollama: ["llama3.3", "mistral", "codellama", "deepseek-r1"],
  OpenAiCompatible: [],
};

/** Self-hosted Pear: the spacetime URI to mint identities against. */
const SELF_HOSTED_WS_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI?.trim() ?? "";

function useAiUserConfig(aiUserId: bigint) {
  const [configs] = useTable(tables.ai_user_config);
  // The config row's primary key `id` matches the AI user's id (kept in
  // lockstep by reducers). With RLS the human admin won't actually see this
  // row in cloud mode — that's fine, the edit form falls back to writing
  // freshly-supplied values rather than pre-filling.
  return configs.find((c) => c.id === aiUserId);
}

// ── AI user card ────────────────────────────────────────────────────────────

function AiUserCard({
  profile,
  onEdit,
  onDelete,
}: {
  profile: AiUserProfileRow;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center gap-3 py-3 border-b border-neutral-200 dark:border-neutral-800">
      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-400 to-indigo-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
        {profile.displayName[0]?.toUpperCase() ?? "?"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
            {profile.displayName}
          </p>
          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-100 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 shrink-0">
            AI
          </span>
          {profile.hasApiKey ? (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 shrink-0"
              title="API key configured"
            >
              key set
            </span>
          ) : (
            <span
              className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 shrink-0"
              title="No API key — this AI user can't respond yet"
            >
              no key
            </span>
          )}
        </div>
        <p className="text-xs text-neutral-400 truncate">
          {profile.providerName} · {profile.modelName}
        </p>
      </div>

      {confirming ? (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              onDelete();
              setConfirming(false);
            }}
            className="px-2 py-1 rounded text-xs font-medium text-red-600 bg-red-50 dark:bg-red-900/20 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
          >
            Confirm
          </button>
          <button
            onClick={() => setConfirming(false)}
            className="px-2 py-1 rounded text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            onClick={onEdit}
            className="p-1.5 rounded text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Edit"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            onClick={() => setConfirming(true)}
            className="p-1.5 rounded text-neutral-400 hover:text-red-500 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
            title="Remove member"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Invite human stub ───────────────────────────────────────────────────────

function InviteHumanForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setEmail("");
    onDone();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Email address
        </label>
        <input
          autoFocus
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@example.com"
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
      </div>

      <button
        type="submit"
        disabled={!email.trim()}
        className="w-full py-2 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 transition-colors"
      >
        Send invite
      </button>
    </form>
  );
}

// ── Create AI user form ─────────────────────────────────────────────────────

function CreateAiUserForm({ onCreated }: { onCreated: () => void }) {
  const createAiUserReducer = useCreateAiUser();
  const { identity: meIdentity } = useSpacetimeDB();
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<ProviderTag>("Anthropic");
  const [model, setModel] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerInfo = PROVIDERS.find((p) => p.value === provider);
  const suggestions = MODEL_SUGGESTIONS[provider] ?? [];

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim() || !model.trim()) return;
    setSubmitting(true);
    setError(null);

    const req = {
      displayName: displayName.trim(),
      provider,
      model: model.trim(),
      endpoint: providerInfo?.needsEndpoint ? endpoint.trim() || undefined : undefined,
      apiKey: apiKey.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      maxTokens: undefined,
      avatarUrl: undefined,
    };

    try {
      if (isAiUserHostDelegated()) {
        await hostCreateAiUser(req);
      } else {
        if (!meIdentity) {
          throw new Error("Not connected to SpacetimeDB yet — try again in a moment.");
        }
        if (!SELF_HOSTED_WS_URI) {
          throw new Error(
            "NEXT_PUBLIC_SPACETIMEDB_URI is not set; cannot mint AI user identity."
          );
        }
        const minted = await mintIdentity(SELF_HOSTED_WS_URI);
        await createAiUserReducer({
          aiUserIdentity: Identity.fromString(minted.identity),
          createdByIdentity: meIdentity,
          displayName: req.displayName,
          provider: { tag: req.provider },
          model: req.model,
          endpoint: req.endpoint,
          apiKey: req.apiKey,
          systemPrompt: req.systemPrompt,
          maxTokens: req.maxTokens,
          avatarUrl: req.avatarUrl,
        });
      }
      setDisplayName("");
      setModel("");
      setEndpoint("");
      setApiKey("");
      setSystemPrompt("");
      onCreated();
    } catch (err) {
      console.error("[CreateAiUser] error:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Display name
        </label>
        <input
          autoFocus
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="e.g. Claude, Research Assistant"
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Provider
        </label>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => {
                setProvider(p.value);
                setModel("");
              }}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                provider === p.value
                  ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                  : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Model
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="e.g. claude-sonnet-4-20250514"
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setModel(s)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  model === s
                    ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
                    : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {providerInfo?.needsEndpoint && (
        <div>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
            Endpoint URL
          </label>
          <input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={provider === "Ollama" ? "http://localhost:11434/v1" : "https://..."}
            className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
          />
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          API key
          <span className="ml-1 text-neutral-400 font-normal">(stored server-side only)</span>
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="sk-…"
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow font-mono"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          System prompt
          <span className="ml-1 text-neutral-400 font-normal">(optional)</span>
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="Custom instructions for this AI user…"
          rows={3}
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 resize-none outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <button
        type="submit"
        disabled={!displayName.trim() || !model.trim() || submitting}
        className="w-full py-2 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 transition-colors"
      >
        {submitting ? "Creating…" : "Add AI member"}
      </button>
    </form>
  );
}

// ── Edit AI user form ───────────────────────────────────────────────────────

function EditAiUserForm({
  profile,
  onClose,
}: {
  profile: AiUserProfileRow;
  onClose: () => void;
}) {
  const config = useAiUserConfig(profile.aiUserId);
  const updateProfileReducer = useUpdateAiUserProfile();
  const updateConfigReducer = useUpdateAiUserConfig();
  const setApiKeyReducer = useSetAiUserApiKey();

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [provider, setProvider] = useState<ProviderTag>(
    (config?.provider.tag as ProviderTag | undefined) ?? "Anthropic"
  );
  const [model, setModel] = useState(config?.model ?? "");
  const [endpoint, setEndpoint] = useState(config?.endpoint ?? "");
  const [systemPrompt, setSystemPrompt] = useState(config?.systemPrompt ?? "");
  const [apiKey, setApiKey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);

  const providerInfo = PROVIDERS.find((p) => p.value === provider);
  const suggestions = MODEL_SUGGESTIONS[provider] ?? [];

  const profileDirty = displayName.trim() !== profile.displayName;
  const configDirty =
    provider !== ((config?.provider.tag as ProviderTag | undefined) ?? "Anthropic") ||
    model.trim() !== (config?.model ?? "") ||
    endpoint.trim() !== (config?.endpoint ?? "") ||
    systemPrompt !== (config?.systemPrompt ?? "");
  const apiKeyDirty = apiKey.trim().length > 0;
  const anyDirty = profileDirty || configDirty || apiKeyDirty;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!displayName.trim() || !model.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const aiUserId = profile.aiUserId;

      if (profileDirty) {
        if (isAiUserHostDelegated()) {
          await hostPatchProfile(aiUserId, { displayName: displayName.trim() });
        } else {
          await updateProfileReducer({
            aiUserId,
            displayName: displayName.trim(),
            avatarUrl: profile.avatarUrl,
          });
        }
      }

      if (configDirty) {
        if (isAiUserHostDelegated()) {
          await hostPatchConfig(aiUserId, {
            provider,
            model: model.trim(),
            endpoint: providerInfo?.needsEndpoint ? endpoint.trim() || null : null,
            systemPrompt: systemPrompt.trim() || null,
          });
        } else {
          await updateConfigReducer({
            aiUserId,
            provider: { tag: provider },
            model: model.trim(),
            endpoint: providerInfo?.needsEndpoint ? endpoint.trim() || undefined : undefined,
            systemPrompt: systemPrompt.trim() || undefined,
            maxTokens: config?.maxTokens,
          });
        }
      }

      if (apiKeyDirty) {
        if (isAiUserHostDelegated()) {
          await hostUpsertApiKey(aiUserId, apiKey.trim());
        } else {
          await setApiKeyReducer({ aiUserId, apiKey: apiKey.trim() });
        }
        setApiKey("");
      }

      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 1500);
    } catch (err) {
      console.error("[EditAiUser] error:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleClearKey() {
    setSubmitting(true);
    setError(null);
    try {
      if (isAiUserHostDelegated()) {
        await hostClearApiKey(profile.aiUserId);
      } else {
        await setApiKeyReducer({ aiUserId: profile.aiUserId, apiKey: undefined });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Display name
        </label>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Provider
        </label>
        <div className="flex flex-wrap gap-1.5">
          {PROVIDERS.map((p) => (
            <button
              key={p.value}
              type="button"
              onClick={() => setProvider(p.value)}
              className={`px-3 py-1.5 rounded-lg text-sm transition-colors ${
                provider === p.value
                  ? "bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900"
                  : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-200 dark:hover:bg-neutral-700"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          Model
        </label>
        <input
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
        {suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1.5">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setModel(s)}
                className={`px-2 py-0.5 rounded text-xs transition-colors ${
                  model === s
                    ? "bg-neutral-200 dark:bg-neutral-700 text-neutral-800 dark:text-neutral-200"
                    : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {providerInfo?.needsEndpoint && (
        <div>
          <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
            Endpoint URL
          </label>
          <input
            type="url"
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder={provider === "Ollama" ? "http://localhost:11434/v1" : "https://..."}
            className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
          />
        </div>
      )}

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          System prompt
          <span className="ml-1 text-neutral-400 font-normal">(optional)</span>
        </label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          rows={3}
          className="w-full text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 resize-none outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow"
        />
      </div>

      <div>
        <label className="block text-xs font-medium text-neutral-500 dark:text-neutral-400 mb-1.5">
          API key
          <span className="ml-1 text-neutral-400 font-normal">
            ({profile.hasApiKey ? "set — leave blank to keep" : "not set"})
          </span>
        </label>
        <div className="flex gap-2">
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={profile.hasApiKey ? "•••••••• (replace)" : "sk-…"}
            className="flex-1 text-sm bg-neutral-50 dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg px-3 py-2 text-neutral-800 dark:text-neutral-200 placeholder:text-neutral-400 outline-none focus:ring-1 focus:ring-neutral-400 dark:focus:ring-neutral-600 transition-shadow font-mono"
          />
          {profile.hasApiKey && (
            <button
              type="button"
              onClick={handleClearKey}
              disabled={submitting}
              className="px-3 py-2 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 disabled:opacity-40 transition-colors"
            >
              Clear
            </button>
          )}
        </div>
        <p className="mt-1 text-[11px] text-neutral-400">
          Keys are write-only; the server never returns the value back to clients.
        </p>
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {savedHint && <p className="text-xs text-emerald-500">Saved.</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!anyDirty || submitting || !displayName.trim() || !model.trim()}
          className="flex-1 py-2 rounded-lg bg-neutral-900 dark:bg-neutral-100 text-white dark:text-neutral-900 text-sm font-medium hover:bg-neutral-700 dark:hover:bg-neutral-300 disabled:opacity-40 transition-colors"
        >
          {submitting ? "Saving…" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-lg text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors"
        >
          Done
        </button>
      </div>
    </form>
  );
}

// ── Member type toggle ──────────────────────────────────────────────────────

function MemberTypeToggle({
  isAi,
  onChange,
}: {
  isAi: boolean;
  onChange: (isAi: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <button
        type="button"
        onClick={() => onChange(!isAi)}
        className={`relative w-9 h-5 rounded-full transition-colors ${
          isAi
            ? "bg-violet-500"
            : "bg-neutral-300 dark:bg-neutral-600"
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${
            isAi ? "translate-x-4" : ""
          }`}
        />
      </button>
      <span className="text-sm text-neutral-600 dark:text-neutral-400">
        AI member
      </span>
    </div>
  );
}

// ── Top-level settings panel ────────────────────────────────────────────────

export function AiUsersSettings() {
  const { profiles } = useAiUserProfiles();
  const deleteAiUserReducer = useDeleteAiUser();
  const [showForm, setShowForm] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false);
  const [editingId, setEditingId] = useState<bigint | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const editingProfile = profiles.find((p) => p.aiUserId === editingId);

  function handleClose() {
    setShowForm(false);
    setIsAiMode(false);
  }

  async function handleDelete(aiUserId: bigint) {
    setActionError(null);
    try {
      if (isAiUserHostDelegated()) {
        await hostDeleteAiUser(aiUserId);
      } else {
        await deleteAiUserReducer({ aiUserId });
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        Members
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        Manage who has access to this workspace. Use <span className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 px-1 py-0.5 rounded">@</span> in any page to mention a member.
      </p>

      {actionError && (
        <p className="text-xs text-red-500 mb-3">{actionError}</p>
      )}

      {profiles.length > 0 && (
        <div className="mb-4">
          {profiles.map((p) => (
            <AiUserCard
              key={String(p.aiUserId)}
              profile={p}
              onEdit={() => setEditingId(p.aiUserId)}
              onDelete={() => handleDelete(p.aiUserId)}
            />
          ))}
        </div>
      )}

      {editingProfile && (
        <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              Edit {editingProfile.displayName}
            </h3>
            <button
              onClick={() => setEditingId(null)}
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
            >
              Close
            </button>
          </div>
          <EditAiUserForm
            profile={editingProfile}
            onClose={() => setEditingId(null)}
          />
        </div>
      )}

      {showForm ? (
        <div className="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-neutral-800 dark:text-neutral-200">
              {isAiMode ? "New AI member" : "Invite member"}
            </h3>
            <button
              onClick={handleClose}
              className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
            >
              Cancel
            </button>
          </div>
          <MemberTypeToggle isAi={isAiMode} onChange={setIsAiMode} />
          {isAiMode ? (
            <CreateAiUserForm onCreated={handleClose} />
          ) : (
            <InviteHumanForm onDone={handleClose} />
          )}
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-neutral-600 dark:text-neutral-400 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Add member
        </button>
      )}
    </section>
  );
}
