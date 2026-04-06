"use client";

import { useState } from "react";
import {
  useAiUserProfiles,
  useCreateAiUser,
  useDeleteAiUser,
  type AiUserProfileRow,
} from "@/src/hooks/useAiUsers";

const PROVIDERS = [
  { value: "Anthropic", label: "Anthropic", needsEndpoint: false },
  { value: "OpenAi", label: "OpenAI", needsEndpoint: false },
  { value: "Ollama", label: "Ollama", needsEndpoint: true },
  { value: "OpenAiCompatible", label: "OpenAI Compatible", needsEndpoint: true },
] as const;

const MODEL_SUGGESTIONS: Record<string, string[]> = {
  Anthropic: ["claude-sonnet-4-20250514", "claude-haiku-4-5-20251001", "claude-3-5-sonnet-20241022"],
  OpenAi: ["gpt-4o", "gpt-4o-mini", "o3-mini"],
  Ollama: ["llama3.3", "mistral", "codellama", "deepseek-r1"],
  OpenAiCompatible: [],
};

function AiUserCard({
  profile,
  onDelete,
}: {
  profile: AiUserProfileRow;
  onDelete: (id: bigint) => void;
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
        </div>
        <p className="text-xs text-neutral-400 truncate">
          {profile.providerName} · {profile.modelName}
        </p>
      </div>
      {confirming ? (
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              onDelete(profile.aiUserId);
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
      )}
    </div>
  );
}

function InviteHumanForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    // TODO: implement email invite
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

function CreateAiUserForm({ onCreated }: { onCreated: () => void }) {
  const createAiUser = useCreateAiUser();
  const [displayName, setDisplayName] = useState("");
  const [provider, setProvider] = useState<string>("Anthropic");
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
    const args = {
      displayName: displayName.trim(),
      provider: { tag: provider } as { tag: "Anthropic" | "OpenAi" | "Ollama" | "OpenAiCompatible" },
      model: model.trim(),
      endpoint: providerInfo?.needsEndpoint ? endpoint.trim() || undefined : undefined,
      apiKey: apiKey.trim() || undefined,
      systemPrompt: systemPrompt.trim() || undefined,
      maxTokens: undefined,
      avatarUrl: undefined,
    };
    console.log("[CreateAiUser] calling reducer with:", args);
    try {
      await createAiUser(args);
      console.log("[CreateAiUser] success!");
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

export function AiUsersSettings() {
  const { profiles } = useAiUserProfiles();
  const deleteAiUser = useDeleteAiUser();
  const [showForm, setShowForm] = useState(false);
  const [isAiMode, setIsAiMode] = useState(false);

  function handleClose() {
    setShowForm(false);
    setIsAiMode(false);
  }

  return (
    <section className="mb-10">
      <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-4">
        Members
      </h2>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        Manage who has access to this workspace. Use <span className="font-mono text-xs bg-neutral-100 dark:bg-neutral-800 px-1 py-0.5 rounded">@</span> in any page to mention a member.
      </p>

      {profiles.length > 0 && (
        <div className="mb-4">
          {profiles.map((p) => (
            <AiUserCard
              key={String(p.aiUserId)}
              profile={p}
              onDelete={(id) => deleteAiUser({ aiUserId: id })}
            />
          ))}
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
