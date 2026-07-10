/**
 * `sandbox_bash` host-side runner (task #410, design: docs/SANDBOX_BASH_SPIKE.md).
 *
 * Executes an emulated bash command (just-bash) in a per-call worker_thread:
 * separate V8 isolate, killed after every call, wall-clock and heap caps,
 * in-memory FS only. This is a pure-compute scratchpad over data the caller
 * seeds in — it is NOT the Pear Bridge (`tool_bash`) and must never be
 * presented or treated as having touched a real machine.
 */

import { Worker } from "node:worker_threads";

export interface SandboxBashOptions {
  /** Seed files for the virtual FS, path → content. */
  files?: Record<string, string>;
  /** Wall-clock cap in ms; the isolate is terminated when exceeded. */
  timeoutMs?: number;
}

export interface SandboxBashResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
  timed_out?: boolean;
  /** Set when stdout/stderr were cut at OUTPUT_CAP_CHARS. */
  truncated?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_TIMEOUT_MS = 30_000;
/** Per-stream output cap; beyond this the stream is cut and flagged. */
export const OUTPUT_CAP_CHARS = 64_000;
/** Total seed-file budget (chars) — the FS is in-memory in a capped isolate. */
export const MAX_SEED_CHARS = 2_000_000;
export const MAX_COMMAND_CHARS = 32_000;

export async function runSandboxBash(
  command: string,
  opts: SandboxBashOptions = {},
): Promise<SandboxBashResult> {
  if (!command.trim()) {
    return { ok: false, error: "command is empty" };
  }
  if (command.length > MAX_COMMAND_CHARS) {
    return { ok: false, error: `command exceeds ${MAX_COMMAND_CHARS} chars` };
  }
  if (opts.files) {
    let total = 0;
    for (const [path, content] of Object.entries(opts.files)) {
      if (typeof content !== "string") {
        return { ok: false, error: `seed file "${path}" content must be a string` };
      }
      total += content.length;
    }
    if (total > MAX_SEED_CHARS) {
      return { ok: false, error: `seed files exceed ${MAX_SEED_CHARS} chars total` };
    }
  }
  const timeoutMs = Math.min(
    Math.max(1, Math.floor(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    MAX_TIMEOUT_MS,
  );

  const worker = new Worker(new URL("./sandbox-bash-thread.ts", import.meta.url), {
    workerData: { command, files: opts.files },
    // Heap caps: contain runaway emulated pipelines; the isolate OOM-aborts
    // instead of taking the AiUserWorker process down with it.
    resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 },
  });

  return await new Promise<SandboxBashResult>((resolve) => {
    let settled = false;
    const settle = (result: SandboxBashResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      settle({
        ok: false,
        timed_out: true,
        error: `sandbox_bash timed out after ${timeoutMs}ms (wall clock); the isolate was killed`,
      });
    }, timeoutMs);

    worker.once("message", (msg: { ok: boolean; stdout?: string; stderr?: string; exitCode?: number; error?: string }) => {
      if (!msg.ok) {
        settle({ ok: false, error: msg.error ?? "sandbox execution failed" });
        return;
      }
      const truncated =
        (msg.stdout?.length ?? 0) > OUTPUT_CAP_CHARS ||
        (msg.stderr?.length ?? 0) > OUTPUT_CAP_CHARS;
      settle({
        ok: true,
        stdout: cap(msg.stdout ?? ""),
        stderr: cap(msg.stderr ?? ""),
        exit_code: msg.exitCode ?? 0,
        ...(truncated ? { truncated } : {}),
      });
    });

    worker.once("error", (err) => {
      settle({ ok: false, error: `sandbox isolate error: ${err.message}` });
    });

    worker.once("exit", (code) => {
      // Exit without a message: OOM abort or crash before postMessage.
      settle({ ok: false, error: `sandbox isolate exited without a result (code ${code})` });
    });
  });
}

function cap(s: string): string {
  return s.length > OUTPUT_CAP_CHARS
    ? `${s.slice(0, OUTPUT_CAP_CHARS)}\n[output truncated at ${OUTPUT_CAP_CHARS} chars]`
    : s;
}
