"use client";

import { useCallback, useMemo, useState } from "react";
import {
  useApiEndpointKeysForEndpoint,
  useCreateApiEndpointKey,
  useRevokeApiEndpointKey,
} from "@/src/hooks/useApiEndpoints";
import { useIdentityDriftRecovery } from "@/src/hooks/useIdentityDriftRecovery";
import type { HttpMethod } from "@/src/module_bindings/types";

/**
 * API key management for a single custom HTTP endpoint.
 *
 * Visibility model (target — full state in 0.5.3):
 *   The underlying `api_endpoint_key` table will be RLS'd to `created_by
 *   = :sender` so each operator only sees keys they minted. **In 0.5.2
 *   the RLS filter is not yet in place** (STDB rejects private→public +
 *   add-RLS as a single publish; see `lib.rs` for the full note), so this
 *   panel currently lists every key on the endpoint regardless of who
 *   minted it. Copy is written to be honest in both states.
 *
 * One-time secret reveal:
 *   The raw key is generated client-side, hashed (SHA-256), and only the
 *   hash is sent to the server. The plaintext is rendered exactly once,
 *   inside `RevealedKeyBanner`. After dismissal there is no way to
 *   retrieve it — the operator must rotate (mint new + revoke old).
 *
 * Rotate:
 *   Implemented as `create new with same label/methods/expiry → revoke
 *   old` in two reducer calls. We do NOT bake "rotate" into a single
 *   server reducer because the client must hold the new plaintext for the
 *   one-time reveal regardless, and a server-side rotate would force a
 *   weird "return new key from reducer" channel that the SDK doesn't
 *   support cleanly. Cost of the two-step: a brief window where both keys
 *   are valid; the operator must explicitly confirm the rotate completed
 *   before the old one stops working at all consumers.
 */

interface Props {
  endpointId: bigint;
}

interface RevealedKey {
  rawKey: string;
  label: string;
  via: "create" | "rotate";
}

const ALL_METHODS: { tag: HttpMethod["tag"] }[] = [
  { tag: "Get" },
  { tag: "Post" },
  { tag: "Patch" },
  { tag: "Delete" },
];

const EXPIRY_OPTIONS: { label: string; days: number | null }[] = [
  { label: "Never", days: null },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
];

async function sha256Hex(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateRawKey(): string {
  // 32 random bytes, hex-encoded → 64 hex chars after the `pear_` prefix.
  // crypto.randomUUID gives 16 bytes; we want 32 to match the server's
  // documented "256-bit random secret" claim, so we concat two UUIDs.
  const u1 = crypto.randomUUID().replace(/-/g, "");
  const u2 = crypto.randomUUID().replace(/-/g, "");
  return `pear_${u1}${u2}`;
}

function nowPlusDaysMicros(days: number): bigint {
  const ms = Date.now() + days * 24 * 60 * 60 * 1000;
  // BigInt() constructor instead of `1000n` literal — the web tsconfig
  // targets a pre-ES2020 lib for SSR compatibility, where bigint literals
  // are a syntax error even though `bigint` the type works fine.
  return BigInt(ms) * BigInt(1000);
}

function formatRelative(ts: { microsSinceUnixEpoch: bigint } | null | undefined): string {
  if (!ts) return "—";
  const ms = Number(ts.microsSinceUnixEpoch) / 1000;
  const diff = Date.now() - ms;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatExpiry(ts: { microsSinceUnixEpoch: bigint } | null | undefined): {
  text: string;
  expired: boolean;
} {
  if (!ts) return { text: "Never", expired: false };
  const ms = Number(ts.microsSinceUnixEpoch) / 1000;
  const diff = ms - Date.now();
  if (diff < 0) return { text: "Expired", expired: true };
  if (diff < 86_400_000) return { text: `in ${Math.max(1, Math.floor(diff / 3_600_000))}h`, expired: false };
  return {
    text: `in ${Math.floor(diff / 86_400_000)}d`,
    expired: false,
  };
}

function methodBadge(tag: HttpMethod["tag"]): string {
  switch (tag) {
    case "Get":
      return "GET";
    case "Post":
      return "POST";
    case "Patch":
      return "PATCH";
    case "Delete":
      return "DELETE";
    default:
      return tag;
  }
}

export function ApiEndpointKeysPanel({ endpointId }: Props) {
  const { keys, isReady } = useApiEndpointKeysForEndpoint(endpointId);
  const createKey = useCreateApiEndpointKey();
  const revokeKey = useRevokeApiEndpointKey();
  const checkDrift = useIdentityDriftRecovery();

  const [showCreate, setShowCreate] = useState(false);
  const [revealed, setRevealed] = useState<RevealedKey | null>(null);
  const [pendingId, setPendingId] = useState<bigint | null>(null);
  const [topError, setTopError] = useState<string | null>(null);

  const activeCount = keys.length;

  /**
   * Single helper used by both "create" and the second half of "rotate".
   * Generates plaintext, hashes it, fires the reducer, and returns the
   * raw key so the caller can park it in the reveal banner.
   */
  const mintKey = useCallback(
    async (args: {
      label: string;
      methods: HttpMethod[];
      expiresAtMicros: bigint | undefined;
    }): Promise<string> => {
      const rawKey = generateRawKey();
      const keyHash = await sha256Hex(rawKey);
      await createKey({
        endpointId,
        keyHash,
        label: args.label,
        allowedMethods: args.methods as never,
        expiresAt: args.expiresAtMicros
          ? ({ microsSinceUnixEpoch: args.expiresAtMicros } as never)
          : undefined,
      });
      return rawKey;
    },
    [createKey, endpointId]
  );

  const handleRotate = useCallback(
    async (key: (typeof keys)[number]) => {
      if (!confirm(`Rotate "${key.label}"? A new key will be minted with the same scopes; you'll see the new secret once, and the old key will be revoked immediately after.`)) {
        return;
      }
      setTopError(null);
      setPendingId(key.id);
      try {
        const newLabel = `${key.label} (rotated ${new Date().toISOString().slice(0, 10)})`;
        const rawKey = await mintKey({
          label: newLabel,
          methods: key.allowedMethods as HttpMethod[],
          expiresAtMicros: key.expiresAt?.microsSinceUnixEpoch,
        });
        await revokeKey({ keyId: key.id });
        setRevealed({ rawKey, label: newLabel, via: "rotate" });
      } catch (err) {
        if (checkDrift(err, "rotate the API key")) return;
        setTopError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingId(null);
      }
    },
    [mintKey, revokeKey, checkDrift]
  );

  const handleRevoke = useCallback(
    async (key: (typeof keys)[number]) => {
      if (!confirm(`Revoke "${key.label}"? Any client still using this key will start receiving HTTP 401 immediately. This can't be undone.`)) {
        return;
      }
      setTopError(null);
      setPendingId(key.id);
      try {
        await revokeKey({ keyId: key.id });
      } catch (err) {
        if (checkDrift(err, "revoke the API key")) return;
        setTopError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingId(null);
      }
    },
    [revokeKey, checkDrift]
  );

  return (
    <div className="space-y-3">
      {revealed && (
        <RevealedKeyBanner
          revealed={revealed}
          onDismiss={() => {
            setRevealed(null);
            setShowCreate(false);
          }}
        />
      )}

      {topError && (
        <p className="text-xs text-red-600 dark:text-red-400">{topError}</p>
      )}

      {!isReady ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Loading keys…
        </p>
      ) : activeCount === 0 ? (
        <EmptyState />
      ) : (
        <KeyList
          keys={keys}
          pendingId={pendingId}
          onRevoke={handleRevoke}
          onRotate={handleRotate}
        />
      )}

      {!revealed && !showCreate && (
        <button
          onClick={() => {
            setShowCreate(true);
            setTopError(null);
          }}
          className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          + Create API Key
        </button>
      )}

      {!revealed && showCreate && (
        <CreateKeyForm
          onCancel={() => {
            setShowCreate(false);
            setTopError(null);
          }}
          onCreated={(rawKey, label) => {
            setRevealed({ rawKey, label, via: "create" });
          }}
          mintKey={mintKey}
          checkDrift={checkDrift}
        />
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="text-xs text-neutral-500 dark:text-neutral-400 border border-dashed border-neutral-300 dark:border-neutral-700 rounded p-3">
      No API keys yet. Click below to mint one.
    </div>
  );
}

function KeyList({
  keys,
  pendingId,
  onRevoke,
  onRotate,
}: {
  keys: ReturnType<typeof useApiEndpointKeysForEndpoint>["keys"];
  pendingId: bigint | null;
  onRevoke: (key: (typeof keys)[number]) => void;
  onRotate: (key: (typeof keys)[number]) => void;
}) {
  return (
    <div className="border border-neutral-200 dark:border-neutral-700 rounded overflow-hidden">
      <table className="w-full text-xs">
        <thead className="bg-neutral-50 dark:bg-neutral-800/50 text-neutral-500 dark:text-neutral-400">
          <tr>
            <th className="text-left px-2 py-1.5 font-medium">Label</th>
            <th className="text-left px-2 py-1.5 font-medium">Methods</th>
            <th className="text-left px-2 py-1.5 font-medium">Created</th>
            <th className="text-left px-2 py-1.5 font-medium">Last used</th>
            <th className="text-left px-2 py-1.5 font-medium">Expires</th>
            <th className="text-right px-2 py-1.5 font-medium" />
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const expiry = formatExpiry(k.expiresAt);
            const isPending = pendingId === k.id;
            return (
              <tr
                key={String(k.id)}
                className="border-t border-neutral-200 dark:border-neutral-700"
              >
                <td className="px-2 py-1.5 text-neutral-900 dark:text-neutral-100 font-medium">
                  {k.label}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {k.allowedMethods.map((m) => (
                      <span
                        key={m.tag}
                        className="inline-block px-1.5 py-0.5 text-[10px] font-mono bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 rounded"
                      >
                        {methodBadge(m.tag)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-2 py-1.5 text-neutral-500 dark:text-neutral-400">
                  {formatRelative(k.createdAt)}
                </td>
                <td className="px-2 py-1.5 text-neutral-500 dark:text-neutral-400">
                  {formatRelative(k.lastUsedAt)}
                </td>
                <td
                  className={
                    expiry.expired
                      ? "px-2 py-1.5 text-red-600 dark:text-red-400"
                      : "px-2 py-1.5 text-neutral-500 dark:text-neutral-400"
                  }
                >
                  {expiry.text}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap">
                  <button
                    onClick={() => onRotate(k)}
                    disabled={isPending}
                    className="text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-50 mr-2"
                  >
                    Rotate
                  </button>
                  <button
                    onClick={() => onRevoke(k)}
                    disabled={isPending}
                    className="text-red-500 hover:text-red-700 dark:hover:text-red-400 disabled:opacity-50"
                  >
                    {isPending ? "…" : "Revoke"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function CreateKeyForm({
  onCancel,
  onCreated,
  mintKey,
  checkDrift,
}: {
  onCancel: () => void;
  onCreated: (rawKey: string, label: string) => void;
  mintKey: (args: {
    label: string;
    methods: HttpMethod[];
    expiresAtMicros: bigint | undefined;
  }) => Promise<string>;
  checkDrift: ReturnType<typeof useIdentityDriftRecovery>;
}) {
  const [label, setLabel] = useState("");
  const [methods, setMethods] = useState<Record<string, boolean>>({
    Get: true,
    Post: true,
    Patch: true,
    Delete: true,
  });
  const [expiryDays, setExpiryDays] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enabledMethods: HttpMethod[] = useMemo(
    () =>
      ALL_METHODS.filter((m) => methods[m.tag]).map(
        (m) => ({ tag: m.tag } as HttpMethod)
      ),
    [methods]
  );

  const canSubmit = label.trim().length > 0 && enabledMethods.length > 0 && !pending;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setError(null);
    setPending(true);
    try {
      const expiresAtMicros =
        expiryDays != null ? nowPlusDaysMicros(expiryDays) : undefined;
      const rawKey = await mintKey({
        label: label.trim(),
        methods: enabledMethods,
        expiresAtMicros,
      });
      onCreated(rawKey, label.trim());
    } catch (err) {
      if (checkDrift(err, "create an API key")) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  }, [canSubmit, expiryDays, mintKey, label, enabledMethods, onCreated, checkDrift]);

  return (
    <div className="border border-neutral-200 dark:border-neutral-700 rounded p-3 space-y-3">
      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
          Key label
        </label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="CI pipeline, Zapier webhook, …"
          disabled={pending}
          className="w-full px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white disabled:opacity-50"
          onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
        />
      </div>

      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
          Allowed methods
        </label>
        <div className="flex gap-3">
          {ALL_METHODS.map((m) => (
            <label
              key={m.tag}
              className="inline-flex items-center gap-1 text-xs text-neutral-700 dark:text-neutral-300"
            >
              <input
                type="checkbox"
                checked={!!methods[m.tag]}
                disabled={pending}
                onChange={(e) =>
                  setMethods((prev) => ({ ...prev, [m.tag]: e.target.checked }))
                }
              />
              {methodBadge(m.tag)}
            </label>
          ))}
        </div>
      </div>

      <div>
        <label className="block text-xs text-neutral-500 dark:text-neutral-400 mb-1">
          Expires
        </label>
        <select
          value={expiryDays ?? ""}
          onChange={(e) =>
            setExpiryDays(e.target.value === "" ? null : Number(e.target.value))
          }
          disabled={pending}
          className="px-2 py-1 text-sm border border-neutral-300 dark:border-neutral-600 rounded bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white disabled:opacity-50"
        >
          {EXPIRY_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.days ?? ""}>
              {opt.label}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">
          Failed to create key: {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={onCancel}
          disabled={pending}
          className="px-2 py-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="px-3 py-1 text-xs bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:opacity-90 transition-opacity disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {pending ? "Generating…" : "Generate"}
        </button>
      </div>
    </div>
  );
}

function RevealedKeyBanner({
  revealed,
  onDismiss,
}: {
  revealed: RevealedKey;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(revealed.rawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="p-3 border border-amber-300 dark:border-amber-600 rounded bg-amber-50 dark:bg-amber-900/20 space-y-2">
      <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
        {revealed.via === "rotate"
          ? `New key for "${revealed.label}" — copy it now. The old key has been revoked.`
          : `New key "${revealed.label}" — copy it now. It will not be shown again.`}
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs bg-white dark:bg-neutral-800 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 font-mono break-all text-neutral-900 dark:text-neutral-100">
          {revealed.rawKey}
        </code>
        <button
          onClick={handleCopy}
          className="px-2 py-1 text-xs bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded hover:opacity-90 transition-opacity shrink-0"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button
        onClick={onDismiss}
        className="text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        I&apos;ve saved it — dismiss
      </button>
    </div>
  );
}
