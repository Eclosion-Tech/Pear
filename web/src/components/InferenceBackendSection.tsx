"use client";

/**
 * Per-AI-user inference backend picker (tickets 14551/14443): Cloud API
 * (default), Bridge inference on a paired device (ollama bindings carry full
 * Pear tool use), or a Harness session (resumable Claude Code with LOCAL
 * tools in a bound working directory).
 *
 * Reads devices/providers from the public `bridge_device_summary` +
 * `bridge_device_capability` tables and writes via
 * `set_ai_user_inference_backend`; the saved binding is displayed from the
 * `AiUserProfile.inference_backend_json` mirror (the RLS-guarded config row is
 * invisible to humans). Rendered by the shared AiUsersSettings component, so
 * it appears in both the OSS app and the pear-cloud workspace settings.
 */

import { useEffect, useMemo, useState } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@/src/module_bindings";
import { useSetAiUserInferenceBackend } from "@/src/hooks/useAiUsers";

type BackendMode = "cloud" | "bridge" | "harness";

interface ParsedBinding {
  mode?: string;
  device_id?: number;
  provider?: string;
  model?: string;
  cwd?: string;
  permission_mode?: string;
  num_ctx?: number;
  think?: boolean;
}

function parseBinding(raw: string | undefined): ParsedBinding | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const v = JSON.parse(raw) as ParsedBinding;
    return typeof v === "object" && v ? v : undefined;
  } catch {
    return undefined;
  }
}

const PERMISSION_MODES = ["acceptEdits", "default", "plan"] as const;

export function InferenceBackendSection({
  aiUserId,
  bindingJson,
  disabled,
}: {
  aiUserId: bigint;
  bindingJson: string | undefined;
  disabled?: boolean;
}) {
  const [devices] = useTable(tables.bridge_device_summary);
  const [capabilities] = useTable(tables.bridge_device_capability);
  const setBackend = useSetAiUserInferenceBackend();

  const saved = useMemo(() => parseBinding(bindingJson), [bindingJson]);
  const [mode, setMode] = useState<BackendMode>(
    saved?.mode === "bridge" ? "bridge" : saved?.mode === "harness" ? "harness" : "cloud",
  );
  const [deviceId, setDeviceId] = useState<string>(saved?.device_id?.toString() ?? "");
  const [provider, setProvider] = useState<string>(saved?.provider ?? "");
  const [model, setModel] = useState<string>(saved?.model ?? "");
  const [cwd, setCwd] = useState<string>(saved?.cwd ?? "");
  const [permissionMode, setPermissionMode] = useState<string>(
    saved?.permission_mode ?? "acceptEdits",
  );
  const [numCtx, setNumCtx] = useState<string>(saved?.num_ctx?.toString() ?? "");
  const [think, setThink] = useState<"default" | "on" | "off">(
    saved?.think === true ? "on" : saved?.think === false ? "off" : "default",
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const next = parseBinding(bindingJson);
    setMode(next?.mode === "bridge" ? "bridge" : next?.mode === "harness" ? "harness" : "cloud");
    setDeviceId(next?.device_id?.toString() ?? "");
    setProvider(next?.provider ?? "");
    setModel(next?.model ?? "");
    setCwd(next?.cwd ?? "");
    setPermissionMode(next?.permission_mode ?? "acceptEdits");
    setNumCtx(next?.num_ctx?.toString() ?? "");
    setThink(next?.think === true ? "on" : next?.think === false ? "off" : "default");
  }, [bindingJson, aiUserId]);

  const activeDevices = useMemo(
    () => (devices ?? []).filter((d) => d.revokedAt == null),
    [devices],
  );
  const deviceCaps = useMemo(
    () => (capabilities ?? []).filter((c) => c.deviceId.toString() === deviceId),
    [capabilities, deviceId],
  );
  const selectedCap = deviceCaps.find((c) => c.provider === provider);
  const ollamaModels = useMemo(() => {
    const cap = deviceCaps.find((c) => c.provider === "ollama");
    try {
      const parsed = JSON.parse(cap?.modelsJson ?? "null");
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }, [deviceCaps]);

  const onSave = async () => {
    setMsg(null);
    setErr(null);
    if (mode !== "cloud") {
      if (!deviceId) {
        setErr("Pick a bridge device.");
        return;
      }
      if (mode === "bridge" && !provider) {
        setErr("Pick a provider on the device.");
        return;
      }
      if (mode === "bridge" && provider === "ollama" && !model.trim()) {
        setErr("Ollama needs an explicit model.");
        return;
      }
    }
    const binding =
      mode === "cloud"
        ? undefined
        : mode === "bridge"
          ? JSON.stringify({
              mode: "bridge",
              device_id: Number(deviceId),
              provider,
              ...(model.trim() ? { model: model.trim() } : {}),
              ...(provider === "ollama" && numCtx.trim() && Number(numCtx) > 0
                ? { num_ctx: Math.floor(Number(numCtx)) }
                : {}),
              ...(provider === "ollama" && think !== "default"
                ? { think: think === "on" }
                : {}),
            })
          : JSON.stringify({
              mode: "harness",
              device_id: Number(deviceId),
              provider: "claude-code",
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              permission_mode: permissionMode,
            });
    setBusy(true);
    try {
      await setBackend({ aiUserId, inferenceBackendJson: binding });
      setMsg(
        mode === "cloud"
          ? "Cleared — this AI user uses its cloud API provider."
          : mode === "bridge"
            ? "Saved — completions now run on the bridge device."
            : "Saved — turns now run as a Claude Code session on the device.",
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectCls =
    "rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 px-3 py-2 text-sm text-neutral-900 dark:text-white disabled:opacity-50";
  const chipCls = (active: boolean) =>
    `px-3 py-1.5 rounded-md text-sm border transition-colors ${
      active
        ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 border-transparent"
        : "border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
    }`;

  return (
    <div>
      <span className="block text-sm font-medium text-neutral-800 dark:text-neutral-200">
        Inference backend
      </span>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5 mb-1.5 max-w-lg">
        Where this AI user&apos;s turns run. <strong>Cloud API</strong> uses the provider and key
        above. <strong>Bridge device</strong> runs inference on a paired machine (ollama models
        keep full Pear tool use; claude-code/codex are chat-only). <strong>Harness session</strong>{" "}
        runs whole turns as a resumable Claude Code session with its local tools in a bound
        directory — Pear tools are off during harness turns. An offline device fails the turn
        visibly; there is no silent fallback.
      </p>
      <div className="flex gap-2 mb-2">
        <button type="button" disabled={disabled || busy} className={chipCls(mode === "cloud")} onClick={() => setMode("cloud")}>
          Cloud API
        </button>
        <button type="button" disabled={disabled || busy} className={chipCls(mode === "bridge")} onClick={() => setMode("bridge")}>
          Bridge device
        </button>
        <button type="button" disabled={disabled || busy} className={chipCls(mode === "harness")} onClick={() => setMode("harness")}>
          Harness session
        </button>
      </div>

      {mode !== "cloud" && (
        <div className="flex flex-col gap-2 mb-2">
          <select
            aria-label="Bridge device"
            value={deviceId}
            disabled={disabled || busy}
            onChange={(e) => {
              setDeviceId(e.target.value);
              setProvider("");
              setModel("");
            }}
            className={selectCls}
          >
            <option value="">Select a device…</option>
            {activeDevices.map((d) => (
              <option key={d.id.toString()} value={d.id.toString()}>
                {d.name} ({d.platform}){d.connected ? "" : " — offline"}
              </option>
            ))}
          </select>

          {mode === "bridge" && deviceId && (
            <>
              <select
                aria-label="Provider"
                value={provider}
                disabled={disabled || busy}
                onChange={(e) => setProvider(e.target.value)}
                className={selectCls}
              >
                <option value="">Select a provider…</option>
                {deviceCaps.map((c) => (
                  <option key={c.provider} value={c.provider} disabled={!c.available}>
                    {c.provider}
                    {c.available ? "" : " — unavailable"}
                    {c.provider === "ollama" ? " (full tool use)" : " (chat-only)"}
                  </option>
                ))}
              </select>
              {deviceCaps.length === 0 && (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                  This device has not reported inference providers — it may be running an older
                  pear-bridge build.
                </p>
              )}
              {provider === "ollama" && ollamaModels.length > 0 ? (
                <select
                  aria-label="Model"
                  value={model}
                  disabled={disabled || busy}
                  onChange={(e) => setModel(e.target.value)}
                  className={selectCls}
                >
                  <option value="">Select a model…</option>
                  {ollamaModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label="Model (optional)"
                  value={model}
                  disabled={disabled || busy}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder={
                    provider === "ollama"
                      ? "Model tag, e.g. llama3.1:8b (required)"
                      : "Model override (optional — provider default)"
                  }
                  className={selectCls}
                />
              )}
              {provider === "ollama" && (
                <div className="flex gap-2">
                  <input
                    aria-label="Context window (num_ctx)"
                    value={numCtx}
                    disabled={disabled || busy}
                    onChange={(e) => setNumCtx(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder="num_ctx (default 32768 — VRAM-bound; e.g. 65536)"
                    className={`${selectCls} flex-1`}
                  />
                  <select
                    aria-label="Thinking"
                    value={think}
                    disabled={disabled || busy}
                    onChange={(e) => setThink(e.target.value as "default" | "on" | "off")}
                    className={selectCls}
                  >
                    <option value="default">thinking: model default</option>
                    <option value="on">thinking: on</option>
                    <option value="off">thinking: off</option>
                  </select>
                </div>
              )}
              {selectedCap && selectedCap.provider !== "ollama" && (
                <p className="text-xs text-neutral-500 dark:text-neutral-400">
                  {selectedCap.provider} bindings are conversational only until harness sessions —
                  use a Harness session for tool-capable Claude Code turns.
                </p>
              )}
            </>
          )}

          {mode === "harness" && deviceId && (
            <>
              <input
                aria-label="Working directory"
                value={cwd}
                disabled={disabled || busy}
                onChange={(e) => setCwd(e.target.value)}
                placeholder="Working directory on the device (defaults to its first allowed directory)"
                className={`${selectCls} font-mono`}
              />
              <select
                aria-label="Permission mode"
                value={permissionMode}
                disabled={disabled || busy}
                onChange={(e) => setPermissionMode(e.target.value)}
                className={selectCls}
              >
                {PERMISSION_MODES.map((m) => (
                  <option key={m} value={m}>
                    permission mode: {m}
                  </option>
                ))}
              </select>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">
                Runs Claude Code on the device (claude-code must be installed there). The directory
                must be inside the device&apos;s allowed directories; each conversation resumes its
                own session.
              </p>
            </>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void onSave()}
          disabled={disabled || busy}
          className="rounded-md border border-neutral-300 dark:border-neutral-600 bg-neutral-100 dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-white hover:opacity-90 disabled:opacity-50"
        >
          {mode === "cloud" && saved ? "Clear binding" : "Save backend"}
        </button>
        {msg && <span className="text-xs text-green-700 dark:text-green-400">{msg}</span>}
        {err && <span className="text-xs text-red-600 dark:text-red-400">{err}</span>}
      </div>
    </div>
  );
}
