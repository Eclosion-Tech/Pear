/**
 * Worker-thread entry for `sandbox_bash` (task #410, docs/SANDBOX_BASH_SPIKE.md).
 *
 * Runs just-bash — a pure-TS bash interpreter over an in-memory virtual
 * filesystem — inside its own V8 isolate so a sandbox breakout (prototype
 * pollution etc.) is contained to this thread, which the host kills after
 * every call. Network stays disabled (just-bash default: no curl config),
 * and the heavier Python/JS WASM runtimes stay off for v1.
 */

import { parentPort, workerData } from "node:worker_threads";
import { Bash } from "just-bash";

type ThreadInput = {
  command: string;
  files?: Record<string, string>;
};

type ThreadResult =
  | { ok: true; stdout: string; stderr: string; exitCode: number }
  | { ok: false; error: string };

const input = workerData as ThreadInput;

try {
  const bash = new Bash({ files: input.files });
  const result = await bash.exec(input.command);
  parentPort!.postMessage({
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  } satisfies ThreadResult);
} catch (err) {
  parentPort!.postMessage({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
  } satisfies ThreadResult);
}
