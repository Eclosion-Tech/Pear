/**
 * Typed IPC client for the pear desktop shell (Tauri v2).
 *
 * The web app runs identically in a browser and inside the desktop app's
 * window; desktop-only surfaces (the Engines panel) mount when `isTauri()`.
 * The desktop grants this remote origin a minimal capability (its own
 * commands + core events) — see desktop/src-tauri/capabilities/.
 */

import { Channel, invoke, isTauri as tauriIsTauri } from "@tauri-apps/api/core";

export function isTauri(): boolean {
  // Guard for SSR: @tauri-apps/api touches window at call time only.
  if (typeof window === "undefined") return false;
  return tauriIsTauri();
}

export interface EngineInfo {
  id: "claude-code" | "codex" | (string & {});
  displayName: string;
  installed: boolean;
  version: string | null;
}

export interface EngineBinding {
  engine: string;
  workspaceKey: string;
  aiUserHex: string;
  aiUserId: number;
  displayName: string;
}

export interface SessionMeta {
  id: string;
  engine: string;
  cwd: string;
  workspaceKey: string;
  title: string;
  status: "running" | "exited" | "crashed" | "cancelled" | (string & {});
  engineSessionId: string | null;
  createdAtMs: number;
  model: string | null;
  transcriptPageId: number | null;
}

/** Normalized engine stream event (see desktop engines/events.rs). */
export type EngineEvent =
  | { kind: "started"; sessionId: string }
  | { kind: "transcriptPage"; pageId: number }
  | { kind: "assistantMessage"; text: string }
  | { kind: "toolUse"; id: string | null; name: string; input: unknown | null }
  | { kind: "toolResult"; toolUseId: string | null; content: unknown | null }
  | { kind: "turnCompleted"; success: boolean; costUsd: number | null; usage: unknown | null }
  | { kind: "raw"; line: Record<string, unknown> }
  | { kind: "stderr"; line: string }
  | { kind: "exited"; code: number | null }
  | { kind: "error"; message: string };

export function enginesDetect(): Promise<EngineInfo[]> {
  return invoke<EngineInfo[]>("engines_detect");
}

export function engineBind(args: {
  engine: string;
  workspaceKey: string;
  aiUserHex: string;
  aiUserId: number;
  displayName: string;
  token: string;
}): Promise<void> {
  return invoke("engine_bind", args);
}

export function enginesBindings(workspaceKey: string): Promise<EngineBinding[]> {
  return invoke<EngineBinding[]>("engines_bindings", { workspaceKey });
}

export interface SessionStartArgs {
  engine: string;
  cwd: string;
  prompt: string;
  title: string;
  workspaceKey: string;
  spacetimedbUri: string;
  dbName: string;
  permissionMode?: string;
  /** Optional engine model override (`--model` / `-m`). */
  model?: string;
  /** Run the session in a fresh git worktree on branch `agent/{id}`. */
  useWorktree?: boolean;
}

export function sessionStart(
  args: SessionStartArgs,
  onEvent: (event: EngineEvent) => void,
): Promise<SessionMeta> {
  const channel = new Channel<EngineEvent>();
  channel.onmessage = onEvent;
  return invoke<SessionMeta>("session_start", { args, onEvent: channel });
}

export function sessionResume(
  args: { sessionId: string; prompt: string; permissionMode?: string },
  onEvent: (event: EngineEvent) => void,
): Promise<SessionMeta> {
  const channel = new Channel<EngineEvent>();
  channel.onmessage = onEvent;
  return invoke<SessionMeta>("session_resume", { args, onEvent: channel });
}

export function sessionSend(sessionId: string, text: string): Promise<void> {
  return invoke("session_send", { sessionId, text });
}

export function sessionCancel(sessionId: string): Promise<void> {
  return invoke("session_cancel", { sessionId });
}

export function sessionsList(workspaceKey: string): Promise<SessionMeta[]> {
  return invoke<SessionMeta[]>("sessions_list", { workspaceKey });
}

export function sessionMeta(sessionId: string): Promise<SessionMeta> {
  return invoke<SessionMeta>("session_meta", { sessionId });
}

// ── Embedded bridge (M5) ────────────────────────────────────────────────────

export interface BridgePairPrep {
  deviceIdentityHex: string;
  deviceTokenHash: string;
  platform: string;
  bridgeVersion: string;
}

export interface BridgeStatus {
  status: "stopped" | "running" | "error" | (string & {});
  message: string;
  workspaceKey: string | null;
  warnings: string[];
}

/** Mint device credentials into the OS keychain; returns only what the
 * signed-in web app needs to call `pair_bridge_device` as the owner. */
export function bridgeLocalPairPrepare(
  workspaceKey: string,
  spacetimedbUri: string,
): Promise<BridgePairPrep> {
  return invoke<BridgePairPrep>("bridge_local_pair_prepare", { workspaceKey, spacetimedbUri });
}

export function bridgeLocalStart(
  workspaceKey: string,
  spacetimedbUri: string,
  dbName: string,
): Promise<BridgeStatus> {
  return invoke<BridgeStatus>("bridge_local_start", { workspaceKey, spacetimedbUri, dbName });
}

export function bridgeLocalStop(): Promise<void> {
  return invoke("bridge_local_stop");
}

export function bridgeLocalStatus(): Promise<BridgeStatus> {
  return invoke<BridgeStatus>("bridge_local_status");
}
