"use client";

import { useState } from "react";
import { useSpacetimeDB } from "spacetimedb/react";
import {
  useCurrentUser,
  useUsers,
  useSetUserAdmin,
  useCreateLocalUser,
} from "@/src/hooks/useUser";
import { useCreateAiUser } from "@/src/hooks/useAiUsers";
import {
  hostCreateAiUser,
  identityFromHex,
  isAiUserHostDelegated,
  mintIdentity,
  type ProviderTag,
} from "@/src/lib/aiUserApi";
import { resolveWorkspaceWsUri } from "@/src/lib/workspaceConnections";
import { useWorkspace } from "@/src/providers/WorkspaceProvider";
import { useIdentityDriftRecovery } from "@/src/hooks/useIdentityDriftRecovery";
import type { CreateAiUserParams } from "@/src/module_bindings/types/reducers";

const OIDC_CONFIGURED = !!process.env.NEXT_PUBLIC_SPACETIMEAUTH_CLIENT_ID;

const PROVIDER_OPTIONS: Array<{
  tag: ProviderTag;
  label: string;
  defaultModel: string;
  defaultEndpoint: string;
}> = [
  {
    tag: "Anthropic",
    label: "Anthropic",
    defaultModel: "claude-haiku-4-5-20251001",
    defaultEndpoint: "",
  },
  {
    tag: "OpenAi",
    label: "OpenAI",
    defaultModel: "gpt-4.1-mini",
    defaultEndpoint: "",
  },
  {
    tag: "Ollama",
    label: "Ollama",
    defaultModel: "llama3.1",
    defaultEndpoint: "http://localhost:11434/v1",
  },
  {
    tag: "OpenAiCompatible",
    label: "OpenAI-compatible",
    defaultModel: "gpt-4.1-mini",
    defaultEndpoint: "",
  },
];

function providerDefaults(provider: ProviderTag) {
  return PROVIDER_OPTIONS.find((p) => p.tag === provider) ?? PROVIDER_OPTIONS[0];
}

function optionalString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalPositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const n = Number(trimmed);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function AddUserForm({ onDone }: { onDone: () => void }) {
  const { identity } = useSpacetimeDB();
  const { activeWorkspace } = useWorkspace();
  const createLocalUser = useCreateLocalUser();
  const createAiUser = useCreateAiUser();
  const hostDelegatedAiUsers = isAiUserHostDelegated();
  const humanUsersManagedExternally = OIDC_CONFIGURED || hostDelegatedAiUsers;

  const [isAiUser, setIsAiUser] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [provider, setProvider] = useState<ProviderTag>("Anthropic");
  const [model, setModel] = useState(providerDefaults("Anthropic").defaultModel);
  const [endpoint, setEndpoint] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [maxTokens, setMaxTokens] = useState("8192");
  const [avatarUrl, setAvatarUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleProviderChange(nextProvider: ProviderTag) {
    const previousDefault = providerDefaults(provider);
    const nextDefault = providerDefaults(nextProvider);
    setProvider(nextProvider);
    if (model.trim() === "" || model === previousDefault.defaultModel) {
      setModel(nextDefault.defaultModel);
    }
    if (endpoint.trim() === "" || endpoint === previousDefault.defaultEndpoint) {
      setEndpoint(nextDefault.defaultEndpoint);
    }
  }

  function resetAfterCreate() {
    setName("");
    setEmail("");
    setPassword("");
    setApiKey("");
    setSystemPrompt("");
    setAvatarUrl("");
  }

  async function createHuman() {
    if (humanUsersManagedExternally) {
      throw new Error(
        "Human users are managed by the configured auth provider or host platform."
      );
    }
    const displayName = name.trim();
    const userEmail = email.trim();
    if (!displayName) throw new Error("Name is required");
    if (!userEmail) throw new Error("Email is required");
    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }

    await createLocalUser({
      email: userEmail,
      name: displayName,
      password,
    });
    setMessage(`${displayName} can now sign in with their email and password.`);
  }

  async function createAi() {
    const displayName = name.trim();
    const modelName = model.trim();
    const endpointValue = optionalString(endpoint);
    const apiKeyValue = optionalString(apiKey);
    const systemPromptValue = optionalString(systemPrompt);
    const avatarValue = optionalString(avatarUrl);
    const maxTokenValue = optionalPositiveInteger(maxTokens);

    if (!displayName) throw new Error("Display name is required");
    if (!modelName) throw new Error("Model is required");
    if (
      (provider === "Ollama" || provider === "OpenAiCompatible") &&
      !endpointValue
    ) {
      throw new Error("Endpoint is required for Ollama and OpenAI-compatible providers");
    }
    if (maxTokens.trim() && maxTokenValue == null) {
      throw new Error("Max tokens must be a positive whole number");
    }

    if (hostDelegatedAiUsers) {
      await hostCreateAiUser({
        displayName,
        provider,
        model: modelName,
        endpoint: endpointValue,
        apiKey: apiKeyValue,
        systemPrompt: systemPromptValue,
        maxTokens: maxTokenValue,
        avatarUrl: avatarValue,
      });
    } else {
      if (!identity) {
        throw new Error("Connect to the workspace before creating an AI user.");
      }
      if (!activeWorkspace) {
        throw new Error("No active workspace connection is configured.");
      }

      const minted = await mintIdentity(resolveWorkspaceWsUri(activeWorkspace.wsUri));
      const aiUserIdentity = await identityFromHex(minted.identity);

      await createAiUser({
        aiUserIdentity,
        createdByIdentity: identity,
        displayName,
        provider: { tag: provider },
        model: modelName,
        endpoint: endpointValue,
        apiKey: apiKeyValue,
        systemPrompt: systemPromptValue,
        maxTokens: maxTokenValue,
        avatarUrl: avatarValue,
      } as unknown as CreateAiUserParams);
    }
    setMessage(`${displayName} was added as an AI user.`);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (isAiUser) {
        await createAi();
      } else {
        await createHuman();
      }
      resetAfterCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const endpointRequired =
    provider === "Ollama" || provider === "OpenAiCompatible";

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="mb-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900/40 p-4"
    >
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-sm font-semibold text-neutral-900 dark:text-white">
            Add user
          </h3>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">
            Add a human login in native auth, or create an AI user for this workspace.
          </p>
        </div>
        <label className="shrink-0 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
          <span>AI user</span>
          <button
            type="button"
            role="switch"
            aria-checked={isAiUser}
            onClick={() => {
              setIsAiUser((v) => !v);
              setError(null);
              setMessage(null);
            }}
            disabled={busy}
            className={`relative inline-flex h-6 w-11 rounded-full border transition-colors disabled:opacity-50 ${
              isAiUser
                ? "bg-violet-600 border-violet-600"
                : "bg-neutral-200 border-neutral-300 dark:bg-neutral-700 dark:border-neutral-600"
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform mt-px ${
                isAiUser ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </label>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
            {isAiUser ? "Display name" : "Name"}
          </span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
            placeholder={isAiUser ? "Moss" : "Ada Lovelace"}
            className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
          />
        </label>

        {!isAiUser && (
          <label className="block">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Email
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy || humanUsersManagedExternally}
              placeholder="ada@example.com"
              className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
            />
          </label>
        )}

        {!isAiUser && (
          <label className="block sm:col-span-2">
            <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
              Temporary password
            </span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || humanUsersManagedExternally}
              placeholder="At least 6 characters"
              className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
            />
          </label>
        )}

        {isAiUser && (
          <>
            <label className="block">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Provider
              </span>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value as ProviderTag)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
              >
                {PROVIDER_OPTIONS.map((option) => (
                  <option key={option.tag} value={option.tag}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Model
              </span>
              <input
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
              />
            </label>

            <label className="block">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Max tokens
              </span>
              <input
                type="number"
                min={1}
                step={1}
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Endpoint{endpointRequired ? "" : " (optional)"}
              </span>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                disabled={busy}
                placeholder={
                  provider === "Ollama"
                    ? "http://localhost:11434/v1"
                    : "https://api.example.com/v1"
                }
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                API key{provider === "Ollama" ? " (optional)" : ""}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={busy}
                placeholder={provider === "Ollama" ? "not required for local Ollama" : "sk-..."}
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Assistant instructions
              </span>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={busy}
                rows={3}
                placeholder="Optional system prompt for this AI user"
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50 font-mono"
              />
            </label>

            <label className="block sm:col-span-2">
              <span className="text-xs font-medium text-neutral-600 dark:text-neutral-400">
                Avatar URL (optional)
              </span>
              <input
                type="url"
                value={avatarUrl}
                onChange={(e) => setAvatarUrl(e.target.value)}
                disabled={busy}
                className="mt-1 w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50"
              />
            </label>
          </>
        )}
      </div>

      {!isAiUser && humanUsersManagedExternally && (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          Human users are managed by the configured auth provider or Pear Cloud.
          Invite them there; they will appear here after first sign-in.
        </p>
      )}

      {message && (
        <p className="mt-3 text-sm text-green-700 dark:text-green-300" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-end gap-2">
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
          disabled={busy || (!isAiUser && humanUsersManagedExternally)}
          className="rounded-md bg-neutral-900 dark:bg-neutral-100 px-3 py-1.5 text-sm font-medium text-white dark:text-neutral-900 hover:opacity-90 disabled:opacity-50"
        >
          {busy ? "Adding..." : isAiUser ? "Add AI user" : "Add human"}
        </button>
      </div>
    </form>
  );
}

/**
 * Workspace members + admin role management.
 *
 * Admin model: any authenticated user can read and write workspace content
 * (Pages have no per-row ownership check). Admins additionally inherit
 * management rights over shared infrastructure rows that DO have a
 * `created_by` field — `api_endpoint`, `api_field_mapping`,
 * `api_endpoint_key`. The first user to authenticate on a fresh database
 * is auto-promoted; after that, only existing admins can promote/demote.
 *
 * The server enforces a "can't demote the last admin" rule, so the worst
 * case here is the action fails with a clear error message; the UI still
 * surfaces a confirm() before demotion to keep the foot-gun visible.
 */
export function MembersSettings() {
  const { users, isReady } = useUsers();
  const { user: currentUser } = useCurrentUser();
  const setUserAdmin = useSetUserAdmin();
  const checkDrift = useIdentityDriftRecovery();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const currentUserIsAdmin = currentUser?.isAdmin ?? false;
  // Sort: admins first, then by name/email so the page is deterministic.
  const sorted = [...users].sort((a, b) => {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1;
    return (a.name || a.email).localeCompare(b.name || b.email);
  });

  async function handleToggleAdmin(
    targetIdentity: ReturnType<typeof useUsers>["users"][number]["identity"],
    targetLabel: string,
    nextIsAdmin: boolean
  ) {
    const verb = nextIsAdmin ? "promote" : "demote";
    if (!nextIsAdmin) {
      // Demotion is the only direction with a foot-gun (you can demote
      // yourself if there's >1 admin), so always confirm.
      const ok = window.confirm(
        `Demote ${targetLabel}? They'll lose admin rights and can't manage other users' API endpoints.`
      );
      if (!ok) return;
    }

    setBusy(targetIdentity.toHexString());
    setError(null);
    try {
      await setUserAdmin({ targetIdentity, isAdmin: nextIsAdmin });
    } catch (err) {
      if (checkDrift(err, `${verb} a workspace admin`)) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between gap-3 mb-1">
        <h2 className="text-sm font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">
          Members
        </h2>
        {currentUserIsAdmin && !addOpen && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-md border border-neutral-200 dark:border-neutral-700 px-2.5 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
          >
            Add user
          </button>
        )}
      </div>
      <p className="text-xs text-neutral-500 dark:text-neutral-500 mb-4">
        Workspace admins inherit management rights over shared infrastructure
        like custom API endpoints and API keys.{" "}
        {!currentUserIsAdmin && (
          <span className="text-neutral-600 dark:text-neutral-400">
            Only admins can promote or demote other members.
          </span>
        )}
      </p>

      {currentUserIsAdmin && addOpen && (
        <AddUserForm onDone={() => setAddOpen(false)} />
      )}

      {!isReady ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          Loading members…
        </p>
      ) : sorted.length === 0 ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-500">
          No authenticated members yet.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800 border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          {sorted.map((u) => {
            const isSelf = currentUser?.identity?.isEqual(u.identity) ?? false;
            const targetLabel = u.name || u.email || u.identity.toHexString().slice(0, 8);
            const idHex = u.identity.toHexString();
            const isBusy = busy === idHex;

            return (
              <li
                key={idHex}
                className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-neutral-900"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100 truncate">
                      {targetLabel}
                    </span>
                    {isSelf && (
                      <span className="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-500">
                        you
                      </span>
                    )}
                    {u.isAdmin && (
                      <span className="text-[10px] uppercase tracking-wide font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/50 rounded px-1.5 py-0.5">
                        Admin
                      </span>
                    )}
                  </div>
                  {u.email && u.email !== targetLabel && (
                    <p className="text-xs text-neutral-500 dark:text-neutral-500 truncate">
                      {u.email}
                    </p>
                  )}
                </div>

                {currentUserIsAdmin && (
                  <button
                    onClick={() =>
                      handleToggleAdmin(u.identity, targetLabel, !u.isAdmin)
                    }
                    disabled={isBusy}
                    className="shrink-0 px-2.5 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {isBusy ? "…" : u.isAdmin ? "Demote" : "Promote to admin"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {error && (
        <p className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>
      )}
    </section>
  );
}
